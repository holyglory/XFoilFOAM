// URANS fidelity ladder — shared node-side helpers (pinned contracts 4–7,
// migration 0034). The sweeper consumes these in its ladder tick; the API
// reads the tier counts for the campaign summary payload.
//
// Ladder (contract 5, ONE priority scale — no second scale):
//   1. automatic PRECALC recovery                     — promotion / targeted
//   2. RANS work                                      — existing submit branch
//      with one final verification interleaved after at most eight newly
//      admitted wave-1 jobs while a schedulable verify item remains pending
//   3. admin request-URANS items and idle verify fallback

import {
  AUTO_PRECALC_CONTINUATION_BUDGET_S,
  AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
  MISSING_URANS_VIDEO_REASON,
  URANS_BUDGET_STOP_MARKER,
  URANS_CONTINUATION_REQUIRED_MARKER,
  URANS_VERIFY_DELTA_CD_LIMIT,
  URANS_VERIFY_DELTA_CL_LIMIT,
} from "@aerodb/core";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm";

import type { DB } from "./client";
import {
  hasExactValidSolverManifest,
  hasExactVerifiedRestartableEvidenceArchive,
} from "./evidence-manifest";
import {
  ensureRevisionMethodCompatibilityHash,
  POLAR_COMPATIBILITY_VERSION,
  resolveRevisionMethodCompatibilityHash,
} from "./polar-compatibility-cache";
import {
  ensurePrecalcObligationsInTransaction,
  hasPrecalcContinuationWarning,
  refreshPrecalcSettlementCampaigns,
  type PrecalcObligationCell,
} from "./precalc-obligations";
import {
  recordSolverIncidentInTransaction,
  resolveSolverIncidentsForOwnerInTransaction,
  URANS_RECOVERY_REMEDIATION_VERSION,
} from "./solver-incidents";
import {
  resultAttempts,
  resultClassifications,
  results,
  simulationPresetRevisions,
  simCampaigns,
  simJobs,
  simPrecalcObligationAttempts,
  simPrecalcObligationCampaigns,
  simPrecalcObligationRequests,
  simPrecalcObligations,
  simUransRequestCampaigns,
  simUransRequests,
  simUransVerifyQueue,
  simUransVerifyQueueCampaigns,
  simUransVerifyQueueRequests,
  type SimPrecalcObligation,
  type SimUransRequest,
  type SimUransVerifyQueueItem,
} from "./schema";

// ---------------------------------------------------------------------------
// Verify-queue enqueue (contract 4): an immutable result_attempt that
// classifies ACCEPTED at fidelity 'urans_precalc' owes a full-fidelity
// verification. Fidelity, not regime, owns this obligation: a no-shedding
// URANS attempt is represented as steady-equivalent regime='rans' but is still
// preliminary URANS evidence. Retry ownership and budgets are generation
// scoped; the mutable natural-cell results row is never the identity.
// ---------------------------------------------------------------------------
export {
  AUTO_PRECALC_CONTINUATION_BUDGET_S,
  AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
};

/** Final verification gets one corrective fresh trajectory. A restartable
 * trajectory continues for as many monotonic physical segments as it needs;
 * only repeated measured no-progress moves to that fresh fallback. */
export const FINAL_URANS_MAX_FRESH_ATTEMPTS = 2;
export const FINAL_URANS_MAX_NO_PROGRESS_SEGMENTS = 2;
export const FINAL_URANS_CONTINUATION_BUDGET_S = 6 * 60 * 60;
export const FINAL_URANS_RETRY_BACKOFF_MS = 30_000;

export const FINAL_URANS_OUTCOMES = {
  continuationPending: "continuation_pending",
  continuationRetryWait: "continuation_retry_wait",
  freshRetryPending: "fresh_retry_pending",
  infrastructureRetryWait: "infrastructure_retry_wait",
  mediaRepairPending: "media_repair_pending",
  accepted: "accepted",
  disagreed: "disagreed",
  recoveryExhausted: "final_recovery_exhausted",
  deterministicFailure: "deterministic_failure",
  continuationPermanentFailure: "continuation_permanent_failure",
  ownerless: "ownerless",
} as const;

export interface RunningPrecalcPartialSettlement {
  obligationId: string;
  resultId: string;
  resultAttemptId: string;
  verifyQueueId: string | null;
  verifyQueueCreated: boolean;
  changed: boolean;
}

interface AcceptedPrecalcVerificationCandidate {
  resultId: string;
  resultAttemptId: string;
  airfoilId: string;
  revisionId: string;
  aoaDeg: number;
}

interface AcceptedPrecalcVerificationOwners {
  backgroundOwner: boolean;
  campaignIds: string[];
  requestIds: string[];
  includeResultCampaignOwners?: boolean;
}

/** Project newly accepted running-partial PRECALC evidence into both durable
 * ladder ledgers without terminalizing the multi-case engine job.
 *
 * The terminal job settlement cannot be reused here: it judges every sibling
 * obligation in the composition, including cases the engine has not published
 * yet. This accepted-only path therefore requires all of the following exact
 * identities before it touches one physical cell:
 *
 * - the obligation id named by this PRECALC composition,
 * - the obligation's current job owner,
 * - an immutable result attempt produced by that same job, and
 * - an ACCEPTED `urans_precalc` classification for that exact attempt.
 *
 * Obligation/submission completion commits first. A separate, replayable
 * transaction projects the settled generation into FINAL ownership using the
 * campaign lifecycle lock order (campaign -> queue -> request). This mirrors
 * terminal PRECALC settlement and prevents an obligation lock from inverting
 * against pause/cancel. Replayed running result.json payloads are idempotent;
 * unpublished siblings have no accepted manifest-backed join and remain
 * running/submitted.
 */
export async function settleAcceptedRunningPrecalcPartials(
  db: DB,
  input: { simJobId: string; obligationIds: string[] },
): Promise<RunningPrecalcPartialSettlement[]> {
  const obligationIds = [...new Set(input.obligationIds)].filter(Boolean);
  if (!obligationIds.length) return [];

  const phaseA = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const candidates = await tx
      .select({
        obligationId: simPrecalcObligations.id,
        backgroundOwner: simPrecalcObligations.backgroundOwner,
        obligationState: simPrecalcObligations.state,
        sourceResultId: simPrecalcObligations.sourceResultId,
        sourceResultAttemptId: simPrecalcObligations.sourceResultAttemptId,
        submissionId: simPrecalcObligationAttempts.id,
        submissionState: simPrecalcObligationAttempts.state,
        submissionResultAttemptId: simPrecalcObligationAttempts.resultAttemptId,
        resultId: results.id,
        currentResultAttemptId: results.currentResultAttemptId,
        resultAttemptId: resultAttempts.id,
        qualityWarnings: resultAttempts.qualityWarnings,
        classificationState: resultClassifications.state,
        supersededByResultId: resultClassifications.supersededByResultId,
        airfoilId: results.airfoilId,
        revisionId: results.simulationPresetRevisionId,
        aoaDeg: results.aoaDeg,
      })
      .from(simPrecalcObligations)
      .innerJoin(
        simPrecalcObligationAttempts,
        and(
          eq(
            simPrecalcObligationAttempts.obligationId,
            simPrecalcObligations.id,
          ),
          eq(simPrecalcObligationAttempts.simJobId, input.simJobId),
        ),
      )
      .innerJoin(
        results,
        and(
          eq(results.airfoilId, simPrecalcObligations.airfoilId),
          eq(
            results.simulationPresetRevisionId,
            simPrecalcObligations.revisionId,
          ),
          eq(results.aoaDeg, simPrecalcObligations.aoaDeg),
        ),
      )
      .innerJoin(
        resultAttempts,
        and(
          eq(resultAttempts.resultId, results.id),
          eq(resultAttempts.simJobId, input.simJobId),
          eq(resultAttempts.airfoilId, results.airfoilId),
          eq(
            resultAttempts.simulationPresetRevisionId,
            results.simulationPresetRevisionId,
          ),
          eq(resultAttempts.aoaDeg, results.aoaDeg),
        ),
      )
      .innerJoin(
        resultClassifications,
        eq(resultClassifications.resultAttemptId, resultAttempts.id),
      )
      .where(
        and(
          inArray(simPrecalcObligations.id, obligationIds),
          eq(simPrecalcObligations.latestSimJobId, input.simJobId),
          eq(results.status, "done"),
          eq(results.source, "solved"),
          eq(resultAttempts.status, "done"),
          eq(resultAttempts.source, "solved"),
          sql`${resultAttempts.evidencePayload} ->> 'fidelity' = 'urans_precalc'`,
          inArray(resultClassifications.state, [
            "accepted",
            "superseded_by_urans",
          ]),
        ),
      )
      .orderBy(
        simPrecalcObligations.id,
        sql`${resultAttempts.createdAt} DESC`,
        sql`${resultAttempts.id} DESC`,
      )
      .for("update");

    const settlements: RunningPrecalcPartialSettlement[] = [];
    const acceptedByObligation = new Map<string, (typeof candidates)[number]>();
    for (const candidate of candidates) {
      if (hasPrecalcContinuationWarning(candidate.qualityWarnings)) continue;
      if (!acceptedByObligation.has(candidate.obligationId)) {
        acceptedByObligation.set(candidate.obligationId, candidate);
      }
    }
    for (const candidate of acceptedByObligation.values()) {
      if (!candidate.revisionId) continue;
      if (
        !(await hasExactValidSolverManifest(
          tx,
          candidate.resultId,
          candidate.resultAttemptId,
        ))
      ) {
        continue;
      }
      // A newer canonical pointer is allowed to suppress a duplicate FINAL
      // only when it is itself exact accepted manifest-backed FINAL evidence.
      // RANS, null, rejected, malformed, or unrelated pointers leave the FAST
      // handoff unresolved so a later ingest/reconciliation can repair truth.
      if (candidate.currentResultAttemptId !== candidate.resultAttemptId) {
        const [currentFull] = candidate.currentResultAttemptId
          ? ((await tx.execute(sql`
              SELECT full_attempt.id
              FROM results canonical_result
              JOIN result_attempts full_attempt
                ON full_attempt.id = canonical_result.current_result_attempt_id
               AND full_attempt.result_id = canonical_result.id
               AND full_attempt.airfoil_id = canonical_result.airfoil_id
               AND full_attempt.simulation_preset_revision_id =
                   canonical_result.simulation_preset_revision_id
               AND full_attempt.aoa_deg = canonical_result.aoa_deg
              JOIN result_classifications full_classification
                ON full_classification.result_attempt_id = full_attempt.id
               AND full_classification.state = 'accepted'
              JOIN result_classifications canonical_classification
                ON canonical_classification.result_id = canonical_result.id
               AND canonical_classification.result_attempt_id IS NULL
               AND canonical_classification.state = 'accepted'
               AND canonical_classification.regime IS NOT DISTINCT FROM
                   canonical_result.regime
              LEFT JOIN sim_jobs full_job
                ON full_job.id = full_attempt.sim_job_id
              WHERE canonical_result.id = ${candidate.resultId}
                AND canonical_result.current_result_attempt_id =
                    ${candidate.currentResultAttemptId}
                AND canonical_result.airfoil_id = ${candidate.airfoilId}
                AND canonical_result.simulation_preset_revision_id =
                    ${candidate.revisionId}
                AND canonical_result.aoa_deg = ${candidate.aoaDeg}
                AND canonical_result.status = 'done'
                AND canonical_result.source = 'solved'
                AND canonical_result.method_key = 'openfoam.urans'
                AND canonical_result.fidelity = 'urans_full'
                AND canonical_result.regime IS NOT DISTINCT FROM full_attempt.regime
                AND canonical_result.solver_implementation_id IS NOT DISTINCT FROM
                    full_attempt.solver_implementation_id
                AND full_attempt.status = 'done'
                AND full_attempt.source = 'solved'
                AND full_attempt.regime IN ('rans', 'urans')
                AND full_attempt.method_key = 'openfoam.urans'
                AND full_attempt.evidence_payload ->> 'fidelity' = 'urans_full'
                AND (
                  EXISTS (
                    SELECT 1
                    FROM sim_urans_verify_queue payload_queue
                    WHERE payload_queue.id::text =
                          full_job.request_payload ->> 'verifyQueueItemId'
                      AND full_job.request_payload
                            ->> 'verifyPrecalcResultAttemptId'
                          = ${candidate.resultAttemptId}::uuid::text
                      AND payload_queue.airfoil_id = canonical_result.airfoil_id
                      AND payload_queue.revision_id =
                          canonical_result.simulation_preset_revision_id
                      AND payload_queue.aoa_deg = canonical_result.aoa_deg
                      AND payload_queue.precalc_result_id = canonical_result.id
                      AND payload_queue.precalc_result_attempt_id =
                          ${candidate.resultAttemptId}
                      AND (
                        payload_queue.sim_job_id = full_attempt.sim_job_id
                        OR payload_queue.latest_result_attempt_id = full_attempt.id
                      )
                  )
                  OR EXISTS (
                    SELECT 1
                    FROM sim_urans_verify_queue linked_queue
                    WHERE linked_queue.latest_result_attempt_id = full_attempt.id
                      AND linked_queue.airfoil_id = canonical_result.airfoil_id
                      AND linked_queue.revision_id =
                          canonical_result.simulation_preset_revision_id
                      AND linked_queue.aoa_deg = canonical_result.aoa_deg
                      AND linked_queue.precalc_result_id = canonical_result.id
                      AND linked_queue.precalc_result_attempt_id =
                          ${candidate.resultAttemptId}
                  )
                )
              LIMIT 1
            `)) as unknown as Array<{ id: string }>)
          : [];
        if (
          !currentFull ||
          candidate.classificationState !== "superseded_by_urans" ||
          candidate.supersededByResultId !== candidate.resultId ||
          !(await hasExactValidSolverManifest(
            tx,
            candidate.resultId,
            currentFull.id,
          ))
        ) {
          continue;
        }
      } else if (candidate.classificationState !== "accepted") {
        continue;
      }
      const changed = !(
        candidate.obligationState === "satisfied" &&
        candidate.sourceResultId === candidate.resultId &&
        candidate.sourceResultAttemptId === candidate.resultAttemptId &&
        candidate.submissionState === "accepted" &&
        candidate.submissionResultAttemptId === candidate.resultAttemptId
      );
      if (changed) {
        const completedAt = new Date();
        const [completedObligation] = await tx
          .update(simPrecalcObligations)
          .set({
            state: "satisfied",
            sourceResultId: candidate.resultId,
            sourceResultAttemptId: candidate.resultAttemptId,
            lastOutcome: "accepted",
            lastError: null,
            nextSubmitAt: null,
            completedAt,
          })
          .where(
            and(
              eq(simPrecalcObligations.id, candidate.obligationId),
              eq(simPrecalcObligations.latestSimJobId, input.simJobId),
            ),
          )
          .returning({ id: simPrecalcObligations.id });
        if (!completedObligation) {
          throw new Error(
            `accepted PRECALC partial lost exact obligation ${candidate.obligationId}`,
          );
        }
        const [completedSubmission] = await tx
          .update(simPrecalcObligationAttempts)
          .set({
            state: "accepted",
            outcome: "accepted",
            resultAttemptId: candidate.resultAttemptId,
            error: null,
            completedAt,
          })
          .where(
            and(
              eq(simPrecalcObligationAttempts.id, candidate.submissionId),
              eq(
                simPrecalcObligationAttempts.obligationId,
                candidate.obligationId,
              ),
              eq(simPrecalcObligationAttempts.simJobId, input.simJobId),
            ),
          )
          .returning({ id: simPrecalcObligationAttempts.id });
        if (!completedSubmission) {
          throw new Error(
            `accepted PRECALC partial lost exact submission ${candidate.submissionId}`,
          );
        }
      }

      const resolvedIncidents =
        await resolveSolverIncidentsForOwnerInTransaction(tx, {
          precalcObligationId: candidate.obligationId,
        });
      settlements.push({
        obligationId: candidate.obligationId,
        resultId: candidate.resultId,
        resultAttemptId: candidate.resultAttemptId,
        verifyQueueId: null,
        verifyQueueCreated: false,
        changed: changed || resolvedIncidents > 0,
      });
    }
    return settlements;
  });

  // Phase B deliberately re-derives durable evidence and live ownership. A
  // crash or lifecycle race after Phase A simply leaves a satisfied FAST row;
  // every active PRECALC reconcile tick retries this exact projection.
  const outcome: RunningPrecalcPartialSettlement[] = [];
  for (const settled of phaseA) {
    const projected = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DB;
      const [candidate] = await tx
        .select({
          backgroundOwner: simPrecalcObligations.backgroundOwner,
          resultId: simPrecalcObligations.sourceResultId,
          resultAttemptId: simPrecalcObligations.sourceResultAttemptId,
          airfoilId: simPrecalcObligations.airfoilId,
          revisionId: simPrecalcObligations.revisionId,
          aoaDeg: simPrecalcObligations.aoaDeg,
        })
        .from(simPrecalcObligations)
        .where(
          and(
            eq(simPrecalcObligations.id, settled.obligationId),
            eq(simPrecalcObligations.state, "satisfied"),
          ),
        )
        .limit(1);
      if (!candidate?.resultId || !candidate.resultAttemptId) {
        return { queueId: null, created: false, changed: false };
      }
      const campaignOwners = await tx
        .select({ campaignId: simPrecalcObligationCampaigns.campaignId })
        .from(simPrecalcObligationCampaigns)
        .where(
          and(
            eq(
              simPrecalcObligationCampaigns.obligationId,
              settled.obligationId,
            ),
            eq(simPrecalcObligationCampaigns.state, "active"),
          ),
        );
      const requestOwners = await tx
        .select({
          requestId: simPrecalcObligationRequests.requestId,
          state: simUransRequests.state,
        })
        .from(simPrecalcObligationRequests)
        .innerJoin(
          simUransRequests,
          eq(simUransRequests.id, simPrecalcObligationRequests.requestId),
        )
        .where(
          eq(simPrecalcObligationRequests.obligationId, settled.obligationId),
        );
      const verification =
        await enqueueAcceptedPrecalcVerificationInTransaction(
          tx,
          {
            resultId: candidate.resultId,
            resultAttemptId: candidate.resultAttemptId,
            airfoilId: candidate.airfoilId,
            revisionId: candidate.revisionId,
            aoaDeg: candidate.aoaDeg,
          },
          {
            backgroundOwner: candidate.backgroundOwner,
            campaignIds: campaignOwners.map((owner) => owner.campaignId),
            requestIds: requestOwners.map((owner) => owner.requestId),
          },
          { allowCurrentFullProjection: true },
        );
      for (const requestId of requestOwners.map((owner) => owner.requestId)) {
        const projectedState = await refreshFullUransRequestStateInTransaction(
          tx,
          requestId,
        );
        if (
          projectedState !== null &&
          projectedState !==
            requestOwners.find((owner) => owner.requestId === requestId)?.state
        ) {
          verification.changed = true;
        }
      }
      return verification;
    });
    outcome.push({
      ...settled,
      verifyQueueId: projected.queueId,
      verifyQueueCreated: projected.created,
      changed: settled.changed || projected.changed,
    });
  }

  const changedOutcome = outcome.filter(
    (settlement) => settlement.changed || settlement.verifyQueueCreated,
  );
  if (changedOutcome.length) {
    const campaignIds = await db
      .selectDistinct({
        campaignId: simPrecalcObligationCampaigns.campaignId,
      })
      .from(simPrecalcObligationCampaigns)
      .innerJoin(
        simCampaigns,
        eq(simCampaigns.id, simPrecalcObligationCampaigns.campaignId),
      )
      .where(
        and(
          inArray(
            simPrecalcObligationCampaigns.obligationId,
            changedOutcome.map((settlement) => settlement.obligationId),
          ),
          eq(simPrecalcObligationCampaigns.state, "active"),
          inArray(simCampaigns.status, ["active", "attention", "paused"]),
        ),
      );
    await refreshPrecalcSettlementCampaigns(
      db,
      campaignIds.map((owner) => owner.campaignId),
    );
  }
  return outcome;
}

export type FinalUransOutcome =
  (typeof FINAL_URANS_OUTCOMES)[keyof typeof FINAL_URANS_OUTCOMES];

/** Queue one bounded same-result continuation for a campaign precalc result.
 *
 * The result row is locked while the request is selected/inserted. Any prior
 * continuation for the physical result which completed or crossed the engine
 * submit boundary spends the ONE bounded attempt globally, regardless of how
 * many campaigns reference the evidence. An open request is reused and gains
 * every live owner association. A cancelled pre-submit composition did not
 * spend the attempt and may be recreated. The existing open-cell unique index
 * remains the final race guard.
 */
async function enqueueAutomaticPrecalcContinuations(
  db: DB,
  opts: {
    airfoilId: string;
    revisionId: string;
    campaignId?: string | null;
    aoaDeg?: number | null;
  },
): Promise<number> {
  if (!opts.campaignId) return 0;
  return db.transaction(async (tx) => {
    // Serializes exact-vs-whole overlap checks across automatic and admin
    // request creation. Distinct exact angles still coexist under the same
    // short transaction; the lock protects only metadata composition.
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`urans-request:${opts.airfoilId}:${opts.revisionId}:precalc`}, 0)
      )
    `);
    const candidates = (await tx.execute(sql`
      SELECT r.id, attempt.id AS result_attempt_id, r.airfoil_id,
             r.simulation_preset_revision_id, r.aoa_deg::float8 AS aoa_deg
      FROM results r
      JOIN result_attempts attempt
        ON attempt.id = r.current_result_attempt_id
       AND attempt.result_id = r.id
       AND attempt.airfoil_id = r.airfoil_id
       AND attempt.simulation_preset_revision_id =
           r.simulation_preset_revision_id
       AND attempt.aoa_deg = r.aoa_deg
      JOIN result_classifications rc
        ON rc.result_attempt_id = attempt.id
       AND rc.state = 'rejected'
      JOIN simulation_preset_revisions revision
        ON revision.id = r.simulation_preset_revision_id
      JOIN sim_campaign_points p
        ON p.campaign_id = ${opts.campaignId}
       AND p.result_id = r.id
       AND p.result_attempt_id = attempt.id
       AND p.state = 'terminal'
       AND p.derived_by_symmetry = false
      JOIN sim_campaigns campaign
        ON campaign.id = p.campaign_id
       AND campaign.status IN ('active', 'attention', 'paused')
      WHERE r.airfoil_id = ${opts.airfoilId}
        AND r.simulation_preset_revision_id = ${opts.revisionId}
        AND r.status = 'done'
        ${opts.aoaDeg == null ? sql`` : sql`AND r.aoa_deg = ${opts.aoaDeg}`}
        AND attempt.status IN ('done', 'failed')
        AND attempt.source = 'solved'
        AND attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
        AND attempt.solver_implementation_id IS NOT NULL
        AND revision.solver_implementation_id IS NOT NULL
        AND attempt.solver_implementation_id =
            revision.solver_implementation_id
        AND COALESCE(rc.reasons, ARRAY[]::text[])
              <> ARRAY[${MISSING_URANS_VIDEO_REASON}]::text[]
        AND attempt.engine_job_id IS NOT NULL
        AND attempt.engine_case_slug IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM unnest(COALESCE(attempt.quality_warnings, ARRAY[]::text[])) warning
          WHERE warning LIKE ${"%" + URANS_BUDGET_STOP_MARKER + "%"}
             OR warning LIKE ${"%" + URANS_CONTINUATION_REQUIRED_MARKER + "%"}
        )
        AND (
          SELECT count(*) = 1
            AND bool_and(
              artifact.airfoil_id = attempt.airfoil_id
              AND artifact.sim_job_id IS NOT DISTINCT FROM attempt.sim_job_id
              AND artifact.engine_job_id IS NOT DISTINCT FROM attempt.engine_job_id
              AND artifact.engine_case_slug IS NOT DISTINCT FROM
                  attempt.engine_case_slug
              AND artifact.aoa_deg IS NOT DISTINCT FROM attempt.aoa_deg
              AND artifact.sha256 ~ '^[0-9a-fA-F]{64}$'
              AND artifact.byte_size > 0
              AND length(trim(artifact.storage_key)) > 0
              AND length(trim(artifact.mime_type)) > 0
            )
          FROM solver_evidence_artifacts artifact
          WHERE artifact.result_id = attempt.result_id
            AND artifact.result_attempt_id = attempt.id
            AND artifact.kind = 'manifest'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM sim_urans_requests prior
          LEFT JOIN sim_jobs prior_job ON prior_job.id = prior.sim_job_id
          WHERE prior.continue_from_result_id = r.id
            AND (
              prior.continue_from_result_attempt_id = attempt.id
              OR (
                prior.continue_from_result_attempt_id IS NULL
                AND prior_job.request_payload ->> 'continueFromResultId' =
                    r.id::text
                AND prior_job.request_payload
                      ->> 'continueFromResultAttemptId' = attempt.id::text
              )
            )
            AND prior.state NOT IN ('pending', 'running')
            AND (
              prior.state = 'done'
              OR prior_job.engine_job_id IS NOT NULL
              OR prior_job."submittedAt" IS NOT NULL
            )
        )
      FOR UPDATE OF r
    `)) as unknown as Array<{
      id: string;
      result_attempt_id: string;
      airfoil_id: string;
      simulation_preset_revision_id: string;
      aoa_deg: number;
    }>;
    let created = 0;
    for (const candidate of candidates) {
      if (
        !(await hasExactVerifiedRestartableEvidenceArchive(
          tx,
          candidate.id,
          candidate.result_attempt_id,
        ))
      ) {
        continue;
      }

      const covering = (await tx.execute(sql`
        SELECT id,
               aoa_deg::float8 AS aoa_deg,
               state,
               sim_job_id,
               continue_from_result_id,
               continue_from_result_attempt_id,
               background_owner
        FROM sim_urans_requests
        WHERE airfoil_id = ${candidate.airfoil_id}
          AND revision_id = ${candidate.simulation_preset_revision_id}
          AND fidelity = 'precalc'
          AND state IN ('pending', 'running')
          AND (aoa_deg = ${candidate.aoa_deg} OR aoa_deg IS NULL)
        ORDER BY (aoa_deg IS NULL), "createdAt" ASC
        FOR UPDATE
      `)) as unknown as Array<{
        id: string;
        aoa_deg: number | null;
        state: string;
        sim_job_id: string | null;
        continue_from_result_id: string | null;
        continue_from_result_attempt_id: string | null;
        background_owner: boolean;
      }>;

      // A whole-polar request is different physical work. Never relabel it as
      // an exact same-case continuation, and never schedule duplicate work
      // while it still covers this angle.
      if (covering.some((request) => request.aoa_deg == null)) continue;

      const exactPair = covering.find(
        (request) =>
          request.aoa_deg === candidate.aoa_deg &&
          request.continue_from_result_id === candidate.id &&
          request.continue_from_result_attempt_id ===
            candidate.result_attempt_id,
      );
      let requestId = exactPair?.id;
      const conflict = covering.find(
        (request) => request.aoa_deg === candidate.aoa_deg && !exactPair,
      );
      if (conflict) {
        // Once a conflicting request crossed the submission boundary, defer
        // this checkpoint. It will be reevaluated after that work settles;
        // neither duplicate CFD nor false continuation ownership is created.
        if (conflict.state !== "pending" || conflict.sim_job_id != null) {
          continue;
        }

        // Replace an unsubmitted composition atomically. If insertion or
        // ownership migration fails, the surrounding transaction restores the
        // original row instead of losing the user's pending request.
        await tx.execute(sql`
          UPDATE sim_urans_requests
          SET state = 'cancelled', "updatedAt" = now()
          WHERE id = ${conflict.id}
            AND state = 'pending'
            AND sim_job_id IS NULL
        `);
        const [inserted] = (await tx.execute(sql`
          INSERT INTO sim_urans_requests (
            airfoil_id, revision_id, aoa_deg, fidelity, state, requested_by,
            background_owner, continue_from_result_id,
            continue_from_result_attempt_id, budget_override_s
          ) VALUES (
            ${candidate.airfoil_id}, ${candidate.simulation_preset_revision_id},
            ${candidate.aoa_deg}, 'precalc', 'pending',
            ${AUTO_PRECALC_CONTINUATION_REQUESTED_BY},
            ${conflict.background_owner}, ${candidate.id},
            ${candidate.result_attempt_id},
            ${AUTO_PRECALC_CONTINUATION_BUDGET_S}
          )
          RETURNING id
        `)) as unknown as Array<{ id: string }>;
        if (!inserted) {
          throw new Error(
            `failed to atomically replace unsubmitted PRECALC request ${conflict.id}`,
          );
        }
        requestId = inserted.id;
        await tx.execute(sql`
          INSERT INTO sim_urans_request_campaigns (
            request_id, campaign_id, state, cancelled_at
          )
          SELECT ${requestId}::uuid, campaign_id, state, cancelled_at
          FROM sim_urans_request_campaigns
          WHERE request_id = ${conflict.id}
          ON CONFLICT (request_id, campaign_id) DO UPDATE
            SET state = EXCLUDED.state,
                cancelled_at = EXCLUDED.cancelled_at,
                "updatedAt" = now()
        `);
        await tx.execute(sql`
          UPDATE sim_urans_request_campaigns
          SET state = 'cancelled', cancelled_at = now(), "updatedAt" = now()
          WHERE request_id = ${conflict.id}
            AND state = 'active'
        `);
        created += 1;
      }
      if (!requestId) {
        const [inserted] = (await tx.execute(sql`
          INSERT INTO sim_urans_requests (
            airfoil_id, revision_id, aoa_deg, fidelity, state, requested_by,
            continue_from_result_id, continue_from_result_attempt_id,
            budget_override_s
          ) VALUES (
            ${candidate.airfoil_id}, ${candidate.simulation_preset_revision_id},
            ${candidate.aoa_deg}, 'precalc', 'pending',
            ${AUTO_PRECALC_CONTINUATION_REQUESTED_BY}, ${candidate.id},
            ${candidate.result_attempt_id},
            ${AUTO_PRECALC_CONTINUATION_BUDGET_S}
          )
          RETURNING id
        `)) as unknown as Array<{ id: string }>;
        if (!inserted) {
          throw new Error(
            `failed to create exact PRECALC continuation for ${candidate.id}/${candidate.result_attempt_id}`,
          );
        }
        requestId = inserted.id;
        created += 1;
      }
      // Every live campaign referencing the same source evidence becomes an
      // owner, but only after the physical request proves the same exact pair.
      await tx.execute(sql`
        INSERT INTO sim_urans_request_campaigns (request_id, campaign_id, state)
        SELECT DISTINCT ${requestId}::uuid, campaign.id, 'active'
        FROM sim_campaign_points point
        JOIN sim_campaigns campaign ON campaign.id = point.campaign_id
        WHERE point.result_id = ${candidate.id}
          AND point.derived_by_symmetry = false
          AND campaign.status IN ('active', 'attention', 'paused')
        ON CONFLICT (request_id, campaign_id) DO UPDATE
          SET state = 'active', cancelled_at = NULL, "updatedAt" = now()
      `);
    }
    return created;
  });
}

/** Preserve the semantics of the legacy "continue this full result" action
 * while routing it through the ordinary final-verification controller. The
 * accepted preliminary baseline is still mandatory; once its queue row
 * exists, the exact saved full attempt becomes that row's next continuation
 * source instead of bypassing the queue with a direct full submit. */
async function seedFinalContinuationFromRequestInTransaction(
  tx: DB,
  input: {
    requestId: string;
    queueId: string;
    airfoilId: string;
    revisionId: string;
    aoaDeg: number;
  },
): Promise<boolean> {
  const [request] = await tx
    .select({
      fidelity: simUransRequests.fidelity,
      continueFromResultId: simUransRequests.continueFromResultId,
      continueFromResultAttemptId: simUransRequests.continueFromResultAttemptId,
      budgetOverrideS: simUransRequests.budgetOverrideS,
    })
    .from(simUransRequests)
    .where(eq(simUransRequests.id, input.requestId))
    .limit(1);
  if (
    request?.fidelity !== "full" ||
    !request.continueFromResultId ||
    !request.continueFromResultAttemptId
  )
    return false;

  const [source] = (await tx.execute(sql`
    SELECT attempt.id, attempt.result_id
    FROM result_attempts attempt
    JOIN sim_urans_verify_queue target_queue
      ON target_queue.id = ${input.queueId}
     AND target_queue.airfoil_id = ${input.airfoilId}
     AND target_queue.revision_id = ${input.revisionId}
     AND target_queue.aoa_deg = ${input.aoaDeg}
     AND target_queue.precalc_result_id = ${request.continueFromResultId}
     AND target_queue.precalc_result_attempt_id IS NOT NULL
    JOIN simulation_preset_revisions target_revision
      ON target_revision.id = ${input.revisionId}
    JOIN result_classifications classification
      ON classification.result_attempt_id = attempt.id
     AND classification.state = 'rejected'
    LEFT JOIN sim_jobs continuation_job
      ON continuation_job.id = attempt.sim_job_id
    WHERE attempt.airfoil_id = ${input.airfoilId}
      AND attempt.simulation_preset_revision_id = ${input.revisionId}
      AND attempt.aoa_deg = ${input.aoaDeg}
      AND attempt.result_id = ${request.continueFromResultId}
      AND attempt.id = ${request.continueFromResultAttemptId}
      AND attempt.status IN ('done', 'failed')
      AND attempt.source = 'solved'
      AND attempt.engine_job_id IS NOT NULL
      AND attempt.engine_case_slug IS NOT NULL
      AND attempt.evidence_payload ->> 'fidelity' = 'urans_full'
      AND attempt.solver_implementation_id IS NOT NULL
      AND target_revision.solver_implementation_id IS NOT NULL
      AND attempt.solver_implementation_id IS NOT DISTINCT FROM
        target_revision.solver_implementation_id
      AND (
        (
          continuation_job.request_payload ->> 'verifyQueueItemId'
            = target_queue.id::text
          AND continuation_job.request_payload
                ->> 'verifyPrecalcResultAttemptId'
            = target_queue.precalc_result_attempt_id::text
        )
        OR target_queue.latest_result_attempt_id = attempt.id
      )
      AND EXISTS (
        SELECT 1
        FROM unnest(COALESCE(attempt.quality_warnings, ARRAY[]::text[])) warning
        WHERE warning LIKE ${"%" + URANS_BUDGET_STOP_MARKER + "%"}
           OR warning LIKE ${"%" + URANS_CONTINUATION_REQUIRED_MARKER + "%"}
      )
    ORDER BY attempt."createdAt" DESC, attempt.id DESC
    LIMIT 1
  `)) as unknown as Array<{ id: string; result_id: string }>;
  if (
    !source ||
    !(await hasExactValidSolverManifest(tx, source.result_id, source.id)) ||
    !(await hasExactVerifiedRestartableEvidenceArchive(
      tx,
      source.result_id,
      source.id,
    ))
  )
    return false;

  // A later owner may safely raise the budget, but replay must never erase
  // measured recovery progress/backoff from an already-seeded queue.
  const budgetRaised = (await tx.execute(sql`
    UPDATE sim_urans_verify_queue queue
    SET continuation_budget_override_s = GREATEST(
          COALESCE(queue.continuation_budget_override_s, 0),
          ${request.budgetOverrideS ?? 0}::int
        ),
        "updatedAt" = CASE
          WHEN ${request.budgetOverrideS ?? 0}::int >
               COALESCE(queue.continuation_budget_override_s, 0)
            THEN now()
          ELSE queue."updatedAt"
        END
    WHERE queue.id = ${input.queueId}
      AND queue.state = 'pending'
      AND ${request.budgetOverrideS ?? null}::int IS NOT NULL
      AND ${request.budgetOverrideS ?? 0}::int >
        COALESCE(queue.continuation_budget_override_s, 0)
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const seeded = (await tx.execute(sql`
    UPDATE sim_urans_verify_queue queue
    SET latest_result_attempt_id = ${source.id},
        fresh_attempt_count = GREATEST(queue.fresh_attempt_count, 1),
        continuation_no_progress_count = 0,
        last_outcome = ${FINAL_URANS_OUTCOMES.continuationPending},
        last_error = NULL,
        next_submit_at = NULL,
        "updatedAt" = now()
    WHERE queue.id = ${input.queueId}
      AND queue.state = 'pending'
      AND queue.latest_result_attempt_id IS NULL
      AND queue.fresh_attempt_count = 0
      AND queue.continuation_attempt_count = 0
      AND queue.continuation_no_progress_count = 0
      AND queue.last_outcome IS NULL
      AND queue.last_error IS NULL
      AND queue.next_submit_at IS NULL
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return budgetRaised.length > 0 || seeded.length > 0;
}

/** Allocate or reuse the generation-scoped FINAL ledger and transfer every
 * live owner in the same transaction. Both terminal ingestion and running
 * partial ingestion use this path so request continuation seeding, campaign
 * ownership, cancellation recovery, and idempotency cannot drift. */
async function enqueueAcceptedPrecalcVerificationInTransaction(
  tx: DB,
  candidate: AcceptedPrecalcVerificationCandidate,
  owners: AcceptedPrecalcVerificationOwners,
  options: { allowCurrentFullProjection?: boolean } = {},
): Promise<{ queueId: string | null; created: boolean; changed: boolean }> {
  const campaignIds = new Set(owners.campaignIds.filter(Boolean));
  const requestIds = [...new Set(owners.requestIds.filter(Boolean))];
  if (owners.includeResultCampaignOwners) {
    const resultCampaignOwners = (await tx.execute(sql`
      SELECT DISTINCT campaign.id
      FROM sim_campaign_points point
      JOIN sim_campaigns campaign ON campaign.id = point.campaign_id
      WHERE point.result_id = ${candidate.resultId}
        AND point.result_attempt_id = ${candidate.resultAttemptId}
        AND point.derived_by_symmetry = false
        AND campaign.status IN ('active', 'attention', 'paused')
    `)) as unknown as Array<{ id: string }>;
    resultCampaignOwners.forEach((owner) => campaignIds.add(owner.id));
  }
  const directCampaignIds = new Set(campaignIds);
  if (requestIds.length) {
    const requestCampaignOwners = await tx
      .selectDistinct({ campaignId: simUransRequestCampaigns.campaignId })
      .from(simUransRequestCampaigns)
      .where(
        and(
          inArray(simUransRequestCampaigns.requestId, requestIds),
          eq(simUransRequestCampaigns.state, "active"),
        ),
      );
    requestCampaignOwners.forEach((owner) => campaignIds.add(owner.campaignId));
  }

  // Campaign lifecycle is the outer lock domain. Pause/cancel takes the same
  // campaign rows before shared queue/request rows, so this projection cannot
  // deadlock by starting from an obligation or queue row.
  if (campaignIds.size) {
    await tx
      .select({ id: simCampaigns.id })
      .from(simCampaigns)
      .where(inArray(simCampaigns.id, [...campaignIds]))
      .orderBy(asc(simCampaigns.id))
      .for("share");
  }
  await acquireCoveragePolarLock(tx, candidate.airfoilId, candidate.revisionId);
  const liveCampaignRows = campaignIds.size
    ? await tx
        .select({ id: simCampaigns.id })
        .from(simCampaigns)
        .where(
          and(
            inArray(simCampaigns.id, [...campaignIds]),
            inArray(simCampaigns.status, ["active", "attention", "paused"]),
          ),
        )
    : [];
  const liveCampaignIds = new Set(liveCampaignRows.map((row) => row.id));

  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(
        ${`final-verify-generation:${candidate.resultAttemptId}`},
        0
      )
    )
  `);
  let [existing] = (await tx.execute(sql`
    SELECT id, state
    FROM sim_urans_verify_queue
    WHERE precalc_result_attempt_id = ${candidate.resultAttemptId}
    ORDER BY
      CASE state
        WHEN 'done' THEN 0
        WHEN 'disagreed' THEN 1
        WHEN 'pending' THEN 2
        WHEN 'running' THEN 3
        WHEN 'blocked' THEN 4
        ELSE 5
      END,
      "createdAt",
      id
    LIMIT 1
    FOR UPDATE
  `)) as unknown as Array<{ id: string; state: string }>;

  // Queue precedes full-request rows in the shared lifecycle order. Lock all
  // requested owners now, then re-evaluate their state/ownership under lock.
  const lockedRequests = requestIds.length
    ? await tx
        .select({
          id: simUransRequests.id,
          fidelity: simUransRequests.fidelity,
          state: simUransRequests.state,
          backgroundOwner: simUransRequests.backgroundOwner,
        })
        .from(simUransRequests)
        .where(inArray(simUransRequests.id, requestIds))
        .orderBy(asc(simUransRequests.id))
        .for("update")
    : [];
  const liveRequestCampaignRows = requestIds.length
    ? await tx
        .select({
          requestId: simUransRequestCampaigns.requestId,
          campaignId: simUransRequestCampaigns.campaignId,
        })
        .from(simUransRequestCampaigns)
        .where(
          and(
            inArray(simUransRequestCampaigns.requestId, requestIds),
            eq(simUransRequestCampaigns.state, "active"),
          ),
        )
    : [];
  const liveRequestIds = lockedRequests
    .filter(
      (request) =>
        request.fidelity === "full" &&
        ["pending", "running"].includes(request.state) &&
        (request.backgroundOwner ||
          liveRequestCampaignRows.some(
            (owner) =>
              owner.requestId === request.id &&
              liveCampaignIds.has(owner.campaignId),
          )),
    )
    .map((request) => request.id);

  // Revalidate the immutable FAST generation only after the lifecycle locks.
  // This also prevents a classification-only row from allocating a physical
  // queue before its durable manifest exists.
  const [precalc] = await tx
    .select({
      currentResultAttemptId: results.currentResultAttemptId,
      cl: resultAttempts.cl,
      cd: resultAttempts.cd,
      cm: resultAttempts.cm,
      qualityWarnings: resultAttempts.qualityWarnings,
      classificationState: resultClassifications.state,
      supersededByResultId: resultClassifications.supersededByResultId,
    })
    .from(results)
    .innerJoin(
      resultAttempts,
      and(
        eq(resultAttempts.id, candidate.resultAttemptId),
        eq(resultAttempts.resultId, results.id),
        eq(resultAttempts.airfoilId, results.airfoilId),
        eq(
          resultAttempts.simulationPresetRevisionId,
          results.simulationPresetRevisionId,
        ),
        eq(resultAttempts.aoaDeg, results.aoaDeg),
      ),
    )
    .innerJoin(
      resultClassifications,
      eq(resultClassifications.resultAttemptId, resultAttempts.id),
    )
    .where(
      and(
        eq(results.id, candidate.resultId),
        eq(results.airfoilId, candidate.airfoilId),
        eq(results.simulationPresetRevisionId, candidate.revisionId),
        eq(results.aoaDeg, candidate.aoaDeg),
        eq(results.status, "done"),
        eq(resultAttempts.status, "done"),
        eq(resultAttempts.source, "solved"),
        sql`${resultAttempts.evidencePayload} ->> 'fidelity' = 'urans_precalc'`,
        inArray(resultClassifications.state, [
          "accepted",
          "superseded_by_urans",
        ]),
      ),
    )
    .for("update")
    .limit(1);
  if (
    !precalc ||
    hasPrecalcContinuationWarning(precalc.qualityWarnings) ||
    !(await hasExactValidSolverManifest(
      tx,
      candidate.resultId,
      candidate.resultAttemptId,
    )) ||
    !(await hasExactVerifiedRestartableEvidenceArchive(
      tx,
      candidate.resultId,
      candidate.resultAttemptId,
    ))
  ) {
    return { queueId: null, created: false, changed: false };
  }

  const [currentFull] =
    options.allowCurrentFullProjection &&
    precalc.currentResultAttemptId &&
    precalc.currentResultAttemptId !== candidate.resultAttemptId
      ? (
          (await tx.execute(sql`
          SELECT full_attempt.id,
                 full_attempt.result_id,
                 full_attempt.sim_job_id,
                 full_attempt.cl,
                 full_attempt.cd,
                 full_attempt.cm
          FROM results canonical_result
          JOIN result_attempts full_attempt
            ON full_attempt.id = canonical_result.current_result_attempt_id
           AND full_attempt.result_id = canonical_result.id
           AND full_attempt.airfoil_id = canonical_result.airfoil_id
           AND full_attempt.simulation_preset_revision_id =
               canonical_result.simulation_preset_revision_id
           AND full_attempt.aoa_deg = canonical_result.aoa_deg
          JOIN result_classifications full_classification
            ON full_classification.result_attempt_id = full_attempt.id
           AND full_classification.state = 'accepted'
          JOIN result_classifications canonical_classification
            ON canonical_classification.result_id = canonical_result.id
           AND canonical_classification.result_attempt_id IS NULL
           AND canonical_classification.state = 'accepted'
           AND canonical_classification.regime IS NOT DISTINCT FROM
               canonical_result.regime
          LEFT JOIN sim_jobs full_job
            ON full_job.id = full_attempt.sim_job_id
          WHERE canonical_result.id = ${candidate.resultId}
            AND canonical_result.current_result_attempt_id =
                ${precalc.currentResultAttemptId}
            AND canonical_result.airfoil_id = ${candidate.airfoilId}
            AND canonical_result.simulation_preset_revision_id =
                ${candidate.revisionId}
            AND canonical_result.aoa_deg = ${candidate.aoaDeg}
            AND canonical_result.status = 'done'
            AND canonical_result.source = 'solved'
            AND canonical_result.method_key = 'openfoam.urans'
            AND canonical_result.fidelity = 'urans_full'
            AND canonical_result.regime IS NOT DISTINCT FROM full_attempt.regime
            AND canonical_result.solver_implementation_id IS NOT DISTINCT FROM
                full_attempt.solver_implementation_id
            AND full_attempt.status = 'done'
            AND full_attempt.source = 'solved'
            AND full_attempt.regime IN ('rans', 'urans')
            AND full_attempt.method_key = 'openfoam.urans'
            AND full_attempt.evidence_payload ->> 'fidelity' = 'urans_full'
            AND (
              EXISTS (
                SELECT 1
                FROM sim_urans_verify_queue payload_queue
                WHERE payload_queue.id::text =
                      full_job.request_payload ->> 'verifyQueueItemId'
                  AND full_job.request_payload
                        ->> 'verifyPrecalcResultAttemptId'
                      = ${candidate.resultAttemptId}::uuid::text
                  AND payload_queue.airfoil_id = canonical_result.airfoil_id
                  AND payload_queue.revision_id =
                      canonical_result.simulation_preset_revision_id
                  AND payload_queue.aoa_deg = canonical_result.aoa_deg
                  AND payload_queue.precalc_result_id = canonical_result.id
                  AND payload_queue.precalc_result_attempt_id =
                      ${candidate.resultAttemptId}
                  AND (
                    payload_queue.sim_job_id = full_attempt.sim_job_id
                    OR payload_queue.latest_result_attempt_id = full_attempt.id
                  )
              )
              OR EXISTS (
                SELECT 1
                FROM sim_urans_verify_queue linked_queue
                WHERE linked_queue.latest_result_attempt_id = full_attempt.id
                  AND linked_queue.airfoil_id = canonical_result.airfoil_id
                  AND linked_queue.revision_id =
                      canonical_result.simulation_preset_revision_id
                  AND linked_queue.aoa_deg = canonical_result.aoa_deg
                  AND linked_queue.precalc_result_id = canonical_result.id
                  AND linked_queue.precalc_result_attempt_id =
                      ${candidate.resultAttemptId}
              )
            )
          LIMIT 1
          FOR UPDATE OF canonical_result, full_attempt,
            full_classification, canonical_classification
        `)) as unknown as Array<{
            id: string;
            result_id: string;
            sim_job_id: string | null;
            cl: number | null;
            cd: number | null;
            cm: number | null;
          }>
        ).map((row) => ({
          id: row.id,
          resultId: row.result_id,
          simJobId: row.sim_job_id,
          cl: row.cl,
          cd: row.cd,
          cm: row.cm,
        }))
      : [];
  const selectedPrecalc =
    precalc.currentResultAttemptId === candidate.resultAttemptId &&
    precalc.classificationState === "accepted";
  const selectedFull = Boolean(
    currentFull &&
    precalc.classificationState === "superseded_by_urans" &&
    precalc.supersededByResultId === candidate.resultId &&
    (await hasExactValidSolverManifest(tx, candidate.resultId, currentFull.id)),
  );
  if (!selectedPrecalc && !selectedFull) {
    return { queueId: null, created: false, changed: false };
  }

  const liveDirectCampaignIds = [...directCampaignIds].filter((campaignId) =>
    liveCampaignIds.has(campaignId),
  );
  const hasLiveOwner =
    owners.backgroundOwner ||
    liveDirectCampaignIds.length > 0 ||
    liveRequestIds.length > 0;
  if (!hasLiveOwner) return { queueId: null, created: false, changed: false };

  const delta = (full: number | null, fast: number | null): number | null =>
    full != null && fast != null ? full - fast : null;
  let created = false;
  let changed = false;
  if (selectedFull && currentFull) {
    const deltaCl = delta(currentFull.cl, precalc.cl);
    const deltaCd = delta(currentFull.cd, precalc.cd);
    const deltaCm = delta(currentFull.cm, precalc.cm);
    const disagreed =
      (deltaCl !== null && Math.abs(deltaCl) > URANS_VERIFY_DELTA_CL_LIMIT) ||
      (deltaCd !== null && Math.abs(deltaCd) > URANS_VERIFY_DELTA_CD_LIMIT);
    if (existing) {
      const updated = (await tx.execute(sql`
        UPDATE sim_urans_verify_queue
        SET state = ${disagreed ? "disagreed" : "done"},
            sim_job_id = ${currentFull.simJobId},
            verify_result_id = ${currentFull.resultId},
            delta_cl = ${deltaCl}, delta_cd = ${deltaCd}, delta_cm = ${deltaCm},
            fresh_attempt_count = GREATEST(fresh_attempt_count, 1),
            latest_result_attempt_id = ${currentFull.id},
            next_submit_at = NULL,
            last_outcome = ${
              disagreed
                ? FINAL_URANS_OUTCOMES.disagreed
                : FINAL_URANS_OUTCOMES.accepted
            },
            last_error = NULL, "updatedAt" = now()
        WHERE id = ${existing.id}
          AND (
            state IS DISTINCT FROM ${disagreed ? "disagreed" : "done"}
            OR sim_job_id IS DISTINCT FROM ${currentFull.simJobId}
            OR verify_result_id IS DISTINCT FROM ${currentFull.resultId}
            OR delta_cl IS DISTINCT FROM ${deltaCl}
            OR delta_cd IS DISTINCT FROM ${deltaCd}
            OR delta_cm IS DISTINCT FROM ${deltaCm}
            OR latest_result_attempt_id IS DISTINCT FROM ${currentFull.id}
            OR next_submit_at IS NOT NULL
            OR last_outcome IS DISTINCT FROM ${
              disagreed
                ? FINAL_URANS_OUTCOMES.disagreed
                : FINAL_URANS_OUTCOMES.accepted
            }
            OR last_error IS NOT NULL
          )
        RETURNING id
      `)) as unknown as Array<{ id: string }>;
      changed = updated.length > 0;
      existing = { ...existing, state: disagreed ? "disagreed" : "done" };
    } else {
      [existing] = (await tx.execute(sql`
        INSERT INTO sim_urans_verify_queue (
          airfoil_id, revision_id, aoa_deg, background_owner, state,
          sim_job_id, precalc_result_id, precalc_result_attempt_id,
          verify_result_id, delta_cl, delta_cd, delta_cm,
          fresh_attempt_count, latest_result_attempt_id, last_outcome
        ) VALUES (
          ${candidate.airfoilId}, ${candidate.revisionId}, ${candidate.aoaDeg},
          ${owners.backgroundOwner}, ${disagreed ? "disagreed" : "done"},
          ${currentFull.simJobId}, ${candidate.resultId},
          ${candidate.resultAttemptId}, ${currentFull.resultId},
          ${deltaCl}, ${deltaCd}, ${deltaCm}, 1, ${currentFull.id},
          ${
            disagreed
              ? FINAL_URANS_OUTCOMES.disagreed
              : FINAL_URANS_OUTCOMES.accepted
          }
        )
        RETURNING id, state
      `)) as unknown as Array<{ id: string; state: string }>;
      created = Boolean(existing);
      changed = created;
    }
  } else if (!existing) {
    [existing] = (await tx.execute(sql`
      INSERT INTO sim_urans_verify_queue (
        airfoil_id, revision_id, aoa_deg, background_owner, state,
        precalc_result_id, precalc_result_attempt_id
      ) VALUES (
        ${candidate.airfoilId}, ${candidate.revisionId}, ${candidate.aoaDeg},
        ${owners.backgroundOwner}, 'pending', ${candidate.resultId},
        ${candidate.resultAttemptId}
      )
      ON CONFLICT (precalc_result_attempt_id)
        WHERE precalc_result_attempt_id IS NOT NULL
          AND state IN ('pending', 'running')
        DO NOTHING
      RETURNING id, state
    `)) as unknown as Array<{ id: string; state: string }>;
    created = Boolean(existing);
    changed = created;
    if (!existing) {
      [existing] = (await tx.execute(sql`
        SELECT id, state FROM sim_urans_verify_queue
        WHERE precalc_result_attempt_id = ${candidate.resultAttemptId}
        ORDER BY "createdAt", id LIMIT 1 FOR UPDATE
      `)) as unknown as Array<{ id: string; state: string }>;
    }
  }
  const physical = existing;
  if (!physical) {
    throw new Error(
      `accepted PRECALC could not allocate FINAL verification for ${candidate.resultAttemptId}`,
    );
  }

  if (owners.backgroundOwner) {
    const backgroundUpdated = (await tx.execute(sql`
      UPDATE sim_urans_verify_queue
      SET background_owner = true, "updatedAt" = now()
      WHERE id = ${physical.id}
        AND background_owner = false
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    changed ||= backgroundUpdated.length > 0;
  }
  if (selectedPrecalc && physical.state === "cancelled") {
    const reopened = (await tx.execute(sql`
      UPDATE sim_urans_verify_queue
      SET state = 'pending', sim_job_id = NULL, next_submit_at = NULL,
          "updatedAt" = now()
      WHERE id = ${physical.id}
        AND state = 'cancelled'
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    changed ||= reopened.length > 0;
  }
  if (liveDirectCampaignIds.length) {
    for (const campaignId of liveDirectCampaignIds) {
      const associated = (await tx.execute(sql`
        INSERT INTO sim_urans_verify_queue_campaigns (
          queue_id, campaign_id, state, cancelled_at
        ) VALUES (${physical.id}, ${campaignId}, 'active', NULL)
        ON CONFLICT (queue_id, campaign_id) DO UPDATE
          SET state = 'active', cancelled_at = NULL, "updatedAt" = now()
          WHERE sim_urans_verify_queue_campaigns.state <> 'active'
             OR sim_urans_verify_queue_campaigns.cancelled_at IS NOT NULL
        RETURNING queue_id
      `)) as unknown as Array<{ queue_id: string }>;
      changed ||= associated.length > 0;
    }
  }
  for (const requestId of liveRequestIds) {
    const [requestAssociation] = await tx
      .insert(simUransVerifyQueueRequests)
      .values({ queueId: physical.id, requestId })
      .onConflictDoNothing()
      .returning({ queueId: simUransVerifyQueueRequests.queueId });
    changed ||= Boolean(requestAssociation);
    changed ||= await seedFinalContinuationFromRequestInTransaction(tx, {
      requestId,
      queueId: physical.id,
      airfoilId: candidate.airfoilId,
      revisionId: candidate.revisionId,
      aoaDeg: candidate.aoaDeg,
    });
  }

  return { queueId: physical.id, created, changed };
}

export async function enqueuePrecalcVerifications(
  db: DB,
  opts: {
    airfoilId: string;
    revisionId: string;
    campaignId?: string | null;
    aoaDeg?: number | null;
    /** Explicit final-fidelity request that owns the per-point verification.
     * Request ownership is distinct from an autonomous background owner. */
    requestId?: string | null;
  },
): Promise<number> {
  await enqueueAutomaticPrecalcContinuations(db, opts);
  const campaignJoin = opts.campaignId
    ? sql`JOIN sim_campaign_points selected_point
              ON selected_point.campaign_id = ${opts.campaignId}
             AND selected_point.result_id = r.id
             AND selected_point.result_attempt_id = precalc_attempt.id
             AND selected_point.state = 'terminal'
             AND selected_point.derived_by_symmetry = false
            JOIN sim_campaigns selected_campaign
              ON selected_campaign.id = selected_point.campaign_id
             AND selected_campaign.status IN ('active', 'attention', 'paused')`
    : sql``;
  const candidates = (await db.execute(sql`
      SELECT r.id, precalc_attempt.id AS precalc_result_attempt_id,
             r.airfoil_id, r.simulation_preset_revision_id,
             r.aoa_deg::float8 AS aoa_deg,
             precalc_attempt.quality_warnings
      FROM results r
      JOIN result_attempts precalc_attempt
        ON precalc_attempt.id = r.current_result_attempt_id
       AND precalc_attempt.result_id = r.id
       AND precalc_attempt.airfoil_id = r.airfoil_id
       AND precalc_attempt.simulation_preset_revision_id =
           r.simulation_preset_revision_id
       AND precalc_attempt.aoa_deg = r.aoa_deg
      JOIN result_classifications rc
        ON rc.result_attempt_id = precalc_attempt.id
      ${campaignJoin}
      WHERE r.airfoil_id = ${opts.airfoilId}
        AND r.simulation_preset_revision_id = ${opts.revisionId}
        AND r.status = 'done'
        ${opts.aoaDeg == null ? sql`` : sql`AND r.aoa_deg = ${opts.aoaDeg}`}
        AND precalc_attempt.status = 'done'
        AND precalc_attempt.source = 'solved'
        AND precalc_attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
        AND rc.state = 'accepted'
      ORDER BY r.id
    `)) as unknown as Array<{
    id: string;
    precalc_result_attempt_id: string;
    airfoil_id: string;
    simulation_preset_revision_id: string;
    aoa_deg: number;
    quality_warnings: string[] | null;
  }>;
  let created = 0;
  for (const candidate of candidates) {
    if (hasPrecalcContinuationWarning(candidate.quality_warnings)) continue;
    const verification = await db.transaction(
      async (rawTx) =>
        await enqueueAcceptedPrecalcVerificationInTransaction(
          rawTx as unknown as DB,
          {
            resultId: candidate.id,
            resultAttemptId: candidate.precalc_result_attempt_id,
            airfoilId: candidate.airfoil_id,
            revisionId: candidate.simulation_preset_revision_id,
            aoaDeg: candidate.aoa_deg,
          },
          {
            backgroundOwner: !opts.campaignId && !opts.requestId,
            campaignIds: [],
            requestIds: opts.requestId ? [opts.requestId] : [],
            includeResultCampaignOwners: !opts.requestId,
          },
        ),
    );
    if (verification.created) created += 1;
  }
  return created;
}

export interface FullUransRequestCoverage {
  requestId: string;
  totalCells: number;
  precalcObligations: SimPrecalcObligation[];
  verifyQueueIds: string[];
}

/** A full request may be temporarily unable to take ownership of one natural
 * cell because an ordinary queue mutation already owns it. No partial request
 * coverage is committed: the sweeper releases the request claim and retries
 * after that physical cell settles. */
export class FullUransRequestCoverageIncompleteError extends Error {
  constructor(
    readonly requestId: string,
    readonly missingCells: PrecalcObligationCell[],
  ) {
    super(
      `full URANS request ${requestId} could not materialize ${missingCells.length} cell(s)`,
    );
    this.name = "FullUransRequestCoverageIncompleteError";
  }
}

function uniqueSortedCoverageCells(
  cells: PrecalcObligationCell[],
): PrecalcObligationCell[] {
  const byKey = new Map<string, PrecalcObligationCell>();
  for (const cell of cells) {
    if (!Number.isFinite(cell.aoaDeg)) {
      throw new Error("full URANS request coverage requires finite AoA values");
    }
    byKey.set(coverageCellKey(cell), cell);
  }
  return [...byKey.values()].sort(
    (a, b) =>
      a.airfoilId.localeCompare(b.airfoilId) ||
      a.revisionId.localeCompare(b.revisionId) ||
      a.aoaDeg - b.aoaDeg,
  );
}

function coverageCellKey(
  cell: Pick<PrecalcObligationCell, "airfoilId" | "revisionId" | "aoaDeg">,
): string {
  return `${cell.airfoilId}:${cell.revisionId}:${Number(cell.aoaDeg)}`;
}

/** Match the canonical polar writer's compatibility -> revision lock order.
 * Classification and current-result authority are meaningful only inside this
 * boundary; queue projection must never race the refresh that publishes them. */
async function acquireCoveragePolarLock(
  tx: DB,
  airfoilId: string,
  revisionId: string,
): Promise<void> {
  const compatibilityHash = await resolveRevisionMethodCompatibilityHash(
    tx,
    revisionId,
  );
  if (compatibilityHash) {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(
          ${`polar-compatibility:${POLAR_COMPATIBILITY_VERSION}:${airfoilId}:${compatibilityHash}`},
          0
        )
      )
    `);
  }
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`polar-revision:${airfoilId}:${revisionId}`}, 0)
    )
  `);
  const persistedCompatibilityHash =
    await ensureRevisionMethodCompatibilityHash(tx, revisionId);
  if (persistedCompatibilityHash !== compatibilityHash) {
    throw new Error(
      `revision method compatibility hash changed while acquiring ordered coverage locks (${revisionId})`,
    );
  }
}

interface FullCoverageAcceptedCandidate {
  id: string;
  result_attempt_id: string;
  sim_job_id: string | null;
  selected_cl: number | null;
  selected_cd: number | null;
  selected_cm: number | null;
  selected_quality_warnings: string[] | null;
  fidelity: string;
  precalc_result_attempt_id: string | null;
  precalc_cl: number | null;
  precalc_cd: number | null;
  precalc_cm: number | null;
  precalc_quality_warnings: string[] | null;
}

async function acceptedFullCoverageCandidate(
  tx: DB,
  cell: PrecalcObligationCell,
  prelockedGenerationId: string | undefined,
): Promise<FullCoverageAcceptedCandidate | null> {
  const currentCandidates = (await tx.execute(sql`
    SELECT
      result.id,
      selected_attempt.id AS result_attempt_id,
      selected_attempt.sim_job_id,
      selected_attempt.cl AS selected_cl,
      selected_attempt.cd AS selected_cd,
      selected_attempt.cm AS selected_cm,
      selected_attempt.quality_warnings AS selected_quality_warnings,
      selected_attempt.evidence_payload ->> 'fidelity' AS fidelity,
      preliminary_attempt.id AS precalc_result_attempt_id,
      preliminary_attempt.cl AS precalc_cl,
      preliminary_attempt.cd AS precalc_cd,
      preliminary_attempt.cm AS precalc_cm,
      preliminary_attempt.quality_warnings AS precalc_quality_warnings
    FROM results result
    JOIN result_attempts selected_attempt
      ON selected_attempt.id = result.current_result_attempt_id
     AND selected_attempt.result_id = result.id
     AND selected_attempt.airfoil_id = result.airfoil_id
     AND selected_attempt.simulation_preset_revision_id =
         result.simulation_preset_revision_id
     AND selected_attempt.aoa_deg = result.aoa_deg
    JOIN result_classifications classification
      ON classification.result_attempt_id = selected_attempt.id
     AND classification.state = 'accepted'
    LEFT JOIN sim_jobs selected_job
      ON selected_job.id = selected_attempt.sim_job_id
    LEFT JOIN result_classifications canonical_classification
      ON canonical_classification.result_id = result.id
     AND canonical_classification.result_attempt_id IS NULL
    LEFT JOIN LATERAL (
      WITH linked_preliminary AS (
        SELECT DISTINCT
          attempt.id,
          attempt.cl,
          attempt.cd,
          attempt.cm,
          attempt.quality_warnings
        FROM result_attempts attempt
        JOIN result_classifications attempt_classification
          ON attempt_classification.result_attempt_id = attempt.id
         AND attempt_classification.state = 'superseded_by_urans'
         AND attempt_classification.superseded_by_result_id = result.id
        WHERE attempt.result_id = result.id
          AND attempt.airfoil_id = result.airfoil_id
          AND attempt.simulation_preset_revision_id =
              result.simulation_preset_revision_id
          AND attempt.aoa_deg = result.aoa_deg
          AND attempt.status = 'done'
          AND attempt.source = 'solved'
          AND attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
          AND (
            EXISTS (
              SELECT 1
              FROM sim_urans_verify_queue payload_queue
              WHERE payload_queue.id::text =
                    selected_job.request_payload ->> 'verifyQueueItemId'
                AND selected_job.request_payload
                      ->> 'verifyPrecalcResultAttemptId' = attempt.id::text
                AND payload_queue.airfoil_id = result.airfoil_id
                AND payload_queue.revision_id =
                    result.simulation_preset_revision_id
                AND payload_queue.aoa_deg = result.aoa_deg
                AND payload_queue.precalc_result_id = result.id
                AND payload_queue.precalc_result_attempt_id = attempt.id
                AND (
                  payload_queue.sim_job_id = selected_attempt.sim_job_id
                  OR payload_queue.latest_result_attempt_id = selected_attempt.id
                )
            )
            OR EXISTS (
              SELECT 1
              FROM sim_urans_verify_queue linked_queue
              WHERE linked_queue.latest_result_attempt_id = selected_attempt.id
                AND linked_queue.airfoil_id = result.airfoil_id
                AND linked_queue.revision_id =
                    result.simulation_preset_revision_id
                AND linked_queue.aoa_deg = result.aoa_deg
                AND linked_queue.precalc_result_id = result.id
                AND linked_queue.precalc_result_attempt_id = attempt.id
            )
          )
          AND (
            SELECT count(*) = 1
              AND bool_and(
                artifact.airfoil_id = attempt.airfoil_id
                AND artifact.sim_job_id IS NOT DISTINCT FROM attempt.sim_job_id
                AND artifact.engine_job_id IS NOT DISTINCT FROM attempt.engine_job_id
                AND artifact.engine_case_slug IS NOT DISTINCT FROM attempt.engine_case_slug
                AND artifact.aoa_deg IS NOT DISTINCT FROM attempt.aoa_deg
                AND artifact.sha256 ~ '^[0-9a-fA-F]{64}$'
                AND artifact.byte_size > 0
                AND length(trim(artifact.storage_key)) > 0
                AND length(trim(artifact.mime_type)) > 0
              )
            FROM solver_evidence_artifacts artifact
            WHERE artifact.result_id = attempt.result_id
              AND artifact.result_attempt_id = attempt.id
              AND artifact.kind = 'manifest'
          )
      )
      SELECT linked_preliminary.*
      FROM linked_preliminary
      WHERE (SELECT count(*) FROM linked_preliminary) = 1
    ) preliminary_attempt ON true
    WHERE result.airfoil_id = ${cell.airfoilId}
      AND result.simulation_preset_revision_id = ${cell.revisionId}
      AND result.aoa_deg = ${cell.aoaDeg}
      AND result.status = 'done'
      AND selected_attempt.status = 'done'
      AND selected_attempt.source = 'solved'
      AND selected_attempt.evidence_payload ->> 'fidelity'
          IN ('urans_precalc', 'urans_full')
      AND (
        selected_attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
        OR (
          result.source = 'solved'
          AND result.method_key = 'openfoam.urans'
          AND result.fidelity = 'urans_full'
          AND result.regime IS NOT DISTINCT FROM selected_attempt.regime
          AND result.solver_implementation_id IS NOT DISTINCT FROM
              selected_attempt.solver_implementation_id
          AND selected_attempt.regime IN ('rans', 'urans')
          AND selected_attempt.method_key = 'openfoam.urans'
          AND canonical_classification.state = 'accepted'
          AND canonical_classification.regime IS NOT DISTINCT FROM result.regime
          AND preliminary_attempt.id IS NOT NULL
        )
      )
      AND (
        SELECT count(*) = 1
          AND bool_and(
            artifact.airfoil_id = selected_attempt.airfoil_id
            AND artifact.sim_job_id IS NOT DISTINCT FROM selected_attempt.sim_job_id
            AND artifact.engine_job_id IS NOT DISTINCT FROM selected_attempt.engine_job_id
            AND artifact.engine_case_slug IS NOT DISTINCT FROM selected_attempt.engine_case_slug
            AND artifact.aoa_deg IS NOT DISTINCT FROM selected_attempt.aoa_deg
            AND artifact.sha256 ~ '^[0-9a-fA-F]{64}$'
            AND artifact.byte_size > 0
            AND length(trim(artifact.storage_key)) > 0
            AND length(trim(artifact.mime_type)) > 0
          )
        FROM solver_evidence_artifacts artifact
        WHERE artifact.result_id = selected_attempt.result_id
          AND artifact.result_attempt_id = selected_attempt.id
          AND artifact.kind = 'manifest'
      )
    ORDER BY CASE selected_attempt.evidence_payload ->> 'fidelity'
      WHEN 'urans_full' THEN 0
      ELSE 1
    END
    LIMIT 1
  `)) as unknown as FullCoverageAcceptedCandidate[];
  let candidate: FullCoverageAcceptedCandidate | undefined =
    currentCandidates[0];
  if (!candidate) {
    const fallbackRows = (await tx.execute(sql`
      SELECT
        result.id,
        preliminary_attempt.id AS result_attempt_id,
        preliminary_attempt.sim_job_id,
        preliminary_attempt.cl AS selected_cl,
        preliminary_attempt.cd AS selected_cd,
        preliminary_attempt.cm AS selected_cm,
        preliminary_attempt.quality_warnings AS selected_quality_warnings,
        'urans_precalc'::text AS fidelity,
        NULL::uuid AS precalc_result_attempt_id,
        NULL::float8 AS precalc_cl,
        NULL::float8 AS precalc_cd,
        NULL::float8 AS precalc_cm,
        NULL::text[] AS precalc_quality_warnings,
        EXISTS (
          SELECT 1
          FROM sim_urans_verify_queue owned_queue
          WHERE owned_queue.airfoil_id = result.airfoil_id
            AND owned_queue.revision_id = result.simulation_preset_revision_id
            AND owned_queue.aoa_deg = result.aoa_deg
            AND owned_queue.precalc_result_id = result.id
            AND owned_queue.precalc_result_attempt_id = preliminary_attempt.id
        ) AS queue_owned,
        EXISTS (
          SELECT 1
          FROM sim_urans_verify_queue linked_queue
          WHERE linked_queue.airfoil_id = result.airfoil_id
            AND linked_queue.revision_id = result.simulation_preset_revision_id
            AND linked_queue.aoa_deg = result.aoa_deg
            AND linked_queue.precalc_result_id = result.id
            AND linked_queue.precalc_result_attempt_id = preliminary_attempt.id
            AND (
              linked_queue.latest_result_attempt_id = current_attempt.id
              OR (
                linked_queue.id::text =
                  current_job.request_payload ->> 'verifyQueueItemId'
                AND current_job.request_payload
                      ->> 'verifyPrecalcResultAttemptId'
                    = preliminary_attempt.id::text
                AND linked_queue.sim_job_id = current_attempt.sim_job_id
              )
            )
        ) AS linked_to_current
      FROM results result
      JOIN result_attempts current_attempt
        ON current_attempt.id = result.current_result_attempt_id
       AND current_attempt.result_id = result.id
      LEFT JOIN sim_jobs current_job
        ON current_job.id = current_attempt.sim_job_id
      JOIN result_attempts preliminary_attempt
        ON preliminary_attempt.result_id = result.id
       AND preliminary_attempt.airfoil_id = result.airfoil_id
       AND preliminary_attempt.simulation_preset_revision_id =
           result.simulation_preset_revision_id
       AND preliminary_attempt.aoa_deg = result.aoa_deg
      JOIN result_classifications preliminary_classification
        ON preliminary_classification.result_attempt_id = preliminary_attempt.id
       AND preliminary_classification.state IN (
         'accepted', 'superseded_by_urans'
       )
       AND (
         preliminary_classification.state = 'accepted'
         OR preliminary_classification.superseded_by_result_id = result.id
       )
      WHERE result.airfoil_id = ${cell.airfoilId}
        AND result.simulation_preset_revision_id = ${cell.revisionId}
        AND result.aoa_deg = ${cell.aoaDeg}
        AND result.status = 'done'
        AND preliminary_attempt.status = 'done'
        AND preliminary_attempt.source = 'solved'
        AND preliminary_attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
        AND (
          SELECT count(*) = 1
            AND bool_and(
              artifact.airfoil_id = preliminary_attempt.airfoil_id
              AND artifact.sim_job_id IS NOT DISTINCT FROM
                  preliminary_attempt.sim_job_id
              AND artifact.engine_job_id IS NOT DISTINCT FROM
                  preliminary_attempt.engine_job_id
              AND artifact.engine_case_slug IS NOT DISTINCT FROM
                  preliminary_attempt.engine_case_slug
              AND artifact.aoa_deg IS NOT DISTINCT FROM preliminary_attempt.aoa_deg
              AND artifact.sha256 ~ '^[0-9a-fA-F]{64}$'
              AND artifact.byte_size > 0
              AND length(trim(artifact.storage_key)) > 0
              AND length(trim(artifact.mime_type)) > 0
            )
          FROM solver_evidence_artifacts artifact
          WHERE artifact.result_id = preliminary_attempt.result_id
            AND artifact.result_attempt_id = preliminary_attempt.id
            AND artifact.kind = 'manifest'
        )
      ORDER BY preliminary_attempt.id
    `)) as unknown as Array<
      FullCoverageAcceptedCandidate & {
        queue_owned: boolean;
        linked_to_current: boolean;
      }
    >;
    const usable = fallbackRows.filter(
      (row) => !hasPrecalcContinuationWarning(row.selected_quality_warnings),
    );
    const linked = usable.filter((row) => row.linked_to_current);
    const queueOwned = usable.filter((row) => row.queue_owned);
    candidate =
      (linked.length === 1 ? linked[0] : undefined) ??
      (linked.length === 0 && queueOwned.length === 1
        ? queueOwned[0]
        : undefined) ??
      (linked.length === 0 && queueOwned.length === 0 && usable.length === 1
        ? usable[0]
        : undefined);
  }
  if (!candidate) return null;
  const generationId =
    candidate.fidelity === "urans_precalc"
      ? candidate.result_attempt_id
      : candidate.precalc_result_attempt_id;
  if (
    prelockedGenerationId !== undefined &&
    generationId !== prelockedGenerationId
  ) {
    throw new Error(
      `accepted URANS generation changed while materializing coverage for ${coverageCellKey(cell)}`,
    );
  }
  const preliminaryWarnings =
    candidate.fidelity === "urans_precalc"
      ? candidate.selected_quality_warnings
      : candidate.precalc_quality_warnings;
  if (hasPrecalcContinuationWarning(preliminaryWarnings)) return null;
  if (
    !(await hasExactValidSolverManifest(
      tx,
      candidate.id,
      candidate.result_attempt_id,
    )) ||
    (candidate.fidelity === "urans_precalc" &&
      !(await hasExactVerifiedRestartableEvidenceArchive(
        tx,
        candidate.id,
        candidate.result_attempt_id,
      ))) ||
    (candidate.fidelity === "urans_full" &&
      (!candidate.precalc_result_attempt_id ||
        !(await hasExactValidSolverManifest(
          tx,
          candidate.id,
          candidate.precalc_result_attempt_id,
        )) ||
        !(await hasExactVerifiedRestartableEvidenceArchive(
          tx,
          candidate.id,
          candidate.precalc_result_attempt_id,
        ))))
  ) {
    return null;
  }
  return candidate;
}

/** Materialize the one truthful per-point sequence for an explicit final
 * request:
 *
 *   accepted preliminary evidence -> final verify queue
 *   otherwise                      -> preliminary obligation
 *
 * Existing successful or critically blocked final queue rows are linked
 * rather than reopened. Accepted exact final evidence from the removed direct
 * path is projected into a terminal queue record without inventing solver
 * evidence. The transaction either covers every requested cell or rolls back.
 */
export async function ensureFullUransRequestCoverage(
  db: DB,
  input: {
    requestId: string;
    cells: PrecalcObligationCell[];
  },
): Promise<FullUransRequestCoverage> {
  const cells = uniqueSortedCoverageCells(input.cells);
  if (!cells.length) {
    throw new FullUransRequestCoverageIncompleteError(input.requestId, []);
  }
  const requestScope = cells[0]!;
  if (
    cells.some(
      (cell) =>
        cell.airfoilId !== requestScope.airfoilId ||
        cell.revisionId !== requestScope.revisionId,
    )
  ) {
    throw new Error(
      `full URANS request ${input.requestId} coverage spans more than one immutable setup`,
    );
  }
  const outcome = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;

    // Campaign lifecycle owns the outer lock. Match pause/cancel's global
    // order (campaign -> queue -> request -> obligation), then re-read all
    // authority under those locks. An optimistic request/owner read here
    // would let coverage survive a cancellation that was already queued.
    const associatedCampaigns = (await tx.execute(sql`
      SELECT DISTINCT ownership.campaign_id
      FROM sim_urans_request_campaigns ownership
      WHERE ownership.request_id = ${input.requestId}
      ORDER BY ownership.campaign_id
    `)) as unknown as Array<{ campaign_id: string }>;
    if (associatedCampaigns.length) {
      await tx.execute(sql`
        SELECT campaign.id
        FROM sim_campaigns campaign
        WHERE campaign.id = ANY(${sql`ARRAY[${sql.join(
          associatedCampaigns.map((row) => sql`${row.campaign_id}::uuid`),
          sql`, `,
        )}]`})
        ORDER BY campaign.id
        FOR SHARE OF campaign
      `);
    }
    await acquireCoveragePolarLock(
      tx,
      requestScope.airfoilId,
      requestScope.revisionId,
    );
    const coverageCells = sql.join(
      cells.map(
        (cell) =>
          sql`(${cell.airfoilId}::uuid, ${cell.revisionId}::uuid, ${cell.aoaDeg}::float8)`,
      ),
      sql`, `,
    );

    // The immutable PRECALC generation is the shared serialization key for
    // every FAST -> FINAL projection. Discover the generation optimistically,
    // then acquire all generation locks in UUID order *before* touching a
    // queue row. The exact evidence/current-pointer query below revalidates the
    // same generation while holding the result row; a generation published
    // after this snapshot is deliberately left to the replayable handoff.
    const prelockedGenerationByCell = new Map<string, string>();
    for (const cell of cells) {
      const candidate = await acceptedFullCoverageCandidate(
        tx,
        cell,
        undefined,
      );
      if (!candidate) continue;
      const generationId =
        candidate.fidelity === "urans_precalc"
          ? candidate.result_attempt_id
          : candidate.precalc_result_attempt_id;
      if (!generationId) continue;
      prelockedGenerationByCell.set(coverageCellKey(cell), generationId);
    }
    const serializationKeys = [
      ...cells.map(
        (cell) =>
          `full-urans-coverage:${cell.airfoilId}:${cell.revisionId}:${Number(cell.aoaDeg)}`,
      ),
      ...[...new Set(prelockedGenerationByCell.values())].map(
        (generationId) => `final-verify-generation:${generationId}`,
      ),
    ].sort();
    for (const serializationKey of serializationKeys) {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${serializationKey}, 0)
        )
      `);
    }

    await tx.execute(sql`
      SELECT queue.id
      FROM sim_urans_verify_queue queue
      JOIN (VALUES ${coverageCells}) target(airfoil_id, revision_id, aoa_deg)
        ON target.airfoil_id = queue.airfoil_id
       AND target.revision_id = queue.revision_id
       AND target.aoa_deg = queue.aoa_deg
      ORDER BY queue.id
      FOR UPDATE OF queue
    `);
    const [request] = await tx
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, input.requestId))
      .for("update")
      .limit(1);
    if (!request || request.fidelity !== "full") {
      throw new Error(
        `full URANS request ${input.requestId} is missing or has the wrong fidelity`,
      );
    }
    if (!["pending", "running"].includes(request.state)) {
      throw new Error(
        `full URANS request ${input.requestId} is already ${request.state}`,
      );
    }
    const mismatched = cells.filter(
      (cell) =>
        cell.airfoilId !== request.airfoilId ||
        cell.revisionId !== request.revisionId ||
        (request.aoaDeg != null &&
          Number(cell.aoaDeg) !== Number(request.aoaDeg)),
    );
    if (mismatched.length) {
      throw new Error(
        `full URANS request ${input.requestId} coverage does not match its immutable scope`,
      );
    }

    const campaignRows = (await tx.execute(sql`
      SELECT ownership.campaign_id
      FROM sim_urans_request_campaigns ownership
      JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
      WHERE ownership.request_id = ${input.requestId}
        AND ownership.state = 'active'
        AND campaign.status IN ('active', 'attention', 'paused')
      ORDER BY ownership.campaign_id
    `)) as unknown as Array<{ campaign_id: string }>;
    const campaignIds = campaignRows.map((row) => row.campaign_id);
    if (!request.backgroundOwner && !campaignIds.length) {
      await tx
        .update(simUransRequests)
        .set({ state: "cancelled", simJobId: null })
        .where(eq(simUransRequests.id, request.id));
      return { orphanedRequestId: request.id } as const;
    }

    // Preflight truth without result-row locks. Missing FAST evidence takes its
    // durable obligation before any result row, preserving the global order.
    // Candidate result rows are then locked by UUID and revalidated under the
    // polar advisory before a queue is mutated.
    const acceptedByCell = new Map<string, FullCoverageAcceptedCandidate>();
    const missingPrecalc: PrecalcObligationCell[] = [];
    for (const cell of cells) {
      const accepted = await acceptedFullCoverageCandidate(
        tx,
        cell,
        prelockedGenerationByCell.get(coverageCellKey(cell)),
      );
      if (accepted) {
        acceptedByCell.set(coverageCellKey(cell), accepted);
      } else {
        missingPrecalc.push(cell);
      }
    }

    let precalcObligations: SimPrecalcObligation[] = [];
    if (missingPrecalc.length) {
      precalcObligations = await ensurePrecalcObligationsInTransaction(
        tx,
        missingPrecalc,
        {
          campaignIds,
          requestIds: [request.id],
        },
      );
    }

    const acceptedResultIds = [
      ...new Set([...acceptedByCell.values()].map((candidate) => candidate.id)),
    ].sort();
    if (acceptedResultIds.length) {
      await tx.execute(sql`
        SELECT result.id
        FROM results result
        WHERE result.id = ANY(${sql`ARRAY[${sql.join(
          acceptedResultIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]`})
        ORDER BY result.id
        FOR UPDATE OF result
      `);
    }
    for (const cell of cells) {
      const before = acceptedByCell.get(coverageCellKey(cell));
      if (!before) continue;
      const after = await acceptedFullCoverageCandidate(
        tx,
        cell,
        prelockedGenerationByCell.get(coverageCellKey(cell)),
      );
      if (
        !after ||
        after.id !== before.id ||
        after.result_attempt_id !== before.result_attempt_id ||
        after.fidelity !== before.fidelity ||
        after.precalc_result_attempt_id !== before.precalc_result_attempt_id
      ) {
        throw new Error(
          `accepted URANS evidence changed while materializing coverage for ${coverageCellKey(cell)}`,
        );
      }
      acceptedByCell.set(coverageCellKey(cell), after);
    }

    const verifyQueueIds: string[] = [];
    for (const cell of cells) {
      const accepted = acceptedByCell.get(coverageCellKey(cell));
      if (!accepted) continue;
      const acceptedPrecalcAttemptId =
        accepted?.fidelity === "urans_precalc"
          ? accepted.result_attempt_id
          : (accepted?.precalc_result_attempt_id ?? null);
      const queueGenerationScope =
        accepted?.fidelity === "urans_precalc"
          ? sql`AND queue.precalc_result_attempt_id = ${accepted.result_attempt_id}`
          : accepted?.fidelity === "urans_full"
            ? acceptedPrecalcAttemptId
              ? sql`AND queue.precalc_result_attempt_id = ${acceptedPrecalcAttemptId}`
              : sql`AND queue.precalc_result_attempt_id IS NULL
                    AND queue.state IN ('done', 'disagreed')`
            : sql`AND false`;
      const queues = (await tx.execute(sql`
        SELECT queue.id, queue.state
        FROM sim_urans_verify_queue queue
        WHERE queue.airfoil_id = ${cell.airfoilId}
          AND queue.revision_id = ${cell.revisionId}
          AND queue.aoa_deg = ${cell.aoaDeg}
          AND queue.state IN (
            'pending', 'running', 'done', 'disagreed', 'blocked', 'cancelled'
          )
          ${queueGenerationScope}
        ORDER BY
          CASE
            WHEN queue.state IN ('done', 'disagreed') THEN 0
            WHEN queue.state IN ('pending', 'running') THEN 1
            WHEN queue.state = 'blocked' THEN 2
            ELSE 3
          END,
          queue."updatedAt" DESC,
          queue.id
      `)) as unknown as Array<{ id: string; state: string }>;

      let queueId =
        accepted?.fidelity === "urans_full"
          ? (queues[0]?.id ?? null)
          : (queues.find((queue) => ["done", "disagreed"].includes(queue.state))
              ?.id ?? null);
      if (accepted?.fidelity === "urans_full") {
        const delta = (
          full: number | null,
          fast: number | null,
        ): number | null => (full != null && fast != null ? full - fast : null);
        const deltaCl = delta(accepted.selected_cl, accepted.precalc_cl);
        const deltaCd = delta(accepted.selected_cd, accepted.precalc_cd);
        const deltaCm = delta(accepted.selected_cm, accepted.precalc_cm);
        const disagreed =
          (deltaCl !== null &&
            Math.abs(deltaCl) > URANS_VERIFY_DELTA_CL_LIMIT) ||
          (deltaCd !== null && Math.abs(deltaCd) > URANS_VERIFY_DELTA_CD_LIMIT);
        if (queueId) {
          await tx.execute(sql`
            UPDATE sim_urans_verify_queue
            SET state = ${disagreed ? "disagreed" : "done"},
                sim_job_id = ${accepted.sim_job_id},
                verify_result_id = ${accepted.id},
                delta_cl = ${deltaCl}, delta_cd = ${deltaCd},
                delta_cm = ${deltaCm},
                fresh_attempt_count = GREATEST(fresh_attempt_count, 1),
                latest_result_attempt_id = ${accepted.result_attempt_id},
                next_submit_at = NULL,
                last_outcome = ${
                  disagreed
                    ? FINAL_URANS_OUTCOMES.disagreed
                    : FINAL_URANS_OUTCOMES.accepted
                },
                last_error = NULL, "updatedAt" = now()
            WHERE id = ${queueId}
          `);
        } else {
          const [terminal] = (await tx.execute(sql`
          INSERT INTO sim_urans_verify_queue (
            airfoil_id, revision_id, aoa_deg, background_owner, state,
            sim_job_id, precalc_result_id, precalc_result_attempt_id,
            verify_result_id, delta_cl, delta_cd, delta_cm,
            fresh_attempt_count, latest_result_attempt_id, last_outcome
          ) VALUES (
            ${cell.airfoilId}, ${cell.revisionId}, ${cell.aoaDeg}, false,
            ${disagreed ? "disagreed" : "done"}, ${accepted.sim_job_id},
            ${accepted.id}, ${acceptedPrecalcAttemptId}, ${accepted.id},
            ${deltaCl}, ${deltaCd}, ${deltaCm}, 1,
            ${accepted.result_attempt_id},
            ${
              disagreed
                ? FINAL_URANS_OUTCOMES.disagreed
                : FINAL_URANS_OUTCOMES.accepted
            }
          )
          RETURNING id
        `)) as unknown as Array<{ id: string }>;
          queueId = terminal?.id ?? null;
        }
        if (queueId) {
          await resolveSolverIncidentsForOwnerInTransaction(tx, {
            verifyQueueId: queueId,
          });
        }
      }
      queueId ??=
        queues.find((queue) => ["pending", "running"].includes(queue.state))
          ?.id ?? null;
      queueId ??= queues.find((queue) => queue.state === "blocked")?.id ?? null;
      queueId ??=
        queues.find((queue) => queue.state === "cancelled")?.id ?? null;
      if (!queueId && accepted?.fidelity === "urans_precalc") {
        const [inserted] = (await tx.execute(sql`
          INSERT INTO sim_urans_verify_queue (
            airfoil_id, revision_id, aoa_deg, background_owner, state,
            precalc_result_id, precalc_result_attempt_id
          ) VALUES (
            ${cell.airfoilId}, ${cell.revisionId}, ${cell.aoaDeg}, false,
            'pending', ${accepted.id}, ${accepted.result_attempt_id}
          )
          ON CONFLICT (precalc_result_attempt_id)
            WHERE precalc_result_attempt_id IS NOT NULL
              AND state IN ('pending', 'running')
            DO NOTHING
          RETURNING id
        `)) as unknown as Array<{ id: string }>;
        queueId = inserted?.id ?? null;
        if (!queueId) {
          const [raced] = (await tx.execute(sql`
            SELECT id
            FROM sim_urans_verify_queue
            WHERE airfoil_id = ${cell.airfoilId}
              AND revision_id = ${cell.revisionId}
              AND aoa_deg = ${cell.aoaDeg}
              AND precalc_result_attempt_id = ${accepted.result_attempt_id}
            ORDER BY "createdAt", id
            LIMIT 1
          `)) as unknown as Array<{ id: string }>;
          queueId = raced?.id ?? null;
        }
      }

      if (!queueId) {
        throw new FullUransRequestCoverageIncompleteError(request.id, [cell]);
      }
      if (queues.find((queue) => queue.id === queueId)?.state === "cancelled") {
        await tx.execute(sql`
          UPDATE sim_urans_verify_queue
          SET state = 'pending', sim_job_id = NULL, next_submit_at = NULL,
              "updatedAt" = now()
          WHERE id = ${queueId}
            AND state = 'cancelled'
        `);
      }
      await tx
        .insert(simUransVerifyQueueRequests)
        .values({ queueId, requestId: request.id })
        .onConflictDoNothing();
      await seedFinalContinuationFromRequestInTransaction(tx, {
        requestId: request.id,
        queueId,
        airfoilId: cell.airfoilId,
        revisionId: cell.revisionId,
        aoaDeg: cell.aoaDeg,
      });
      verifyQueueIds.push(queueId);
    }

    const coveredCells = (await tx.execute(sql`
      SELECT obligation.airfoil_id,
             obligation.revision_id,
             obligation.aoa_deg::float8 AS aoa_deg
      FROM sim_precalc_obligation_requests coverage
      JOIN sim_precalc_obligations obligation
        ON obligation.id = coverage.obligation_id
      WHERE coverage.request_id = ${request.id}
      UNION
      SELECT queue.airfoil_id,
             queue.revision_id,
             queue.aoa_deg::float8 AS aoa_deg
      FROM sim_urans_verify_queue_requests coverage
      JOIN sim_urans_verify_queue queue ON queue.id = coverage.queue_id
      WHERE coverage.request_id = ${request.id}
    `)) as unknown as Array<{
      airfoil_id: string;
      revision_id: string;
      aoa_deg: number;
    }>;
    const coveredKeys = new Set(
      coveredCells.map(
        (cell) =>
          `${cell.airfoil_id}:${cell.revision_id}:${Number(cell.aoa_deg)}`,
      ),
    );
    const uncovered = cells.filter(
      (cell) =>
        !coveredKeys.has(
          `${cell.airfoilId}:${cell.revisionId}:${Number(cell.aoaDeg)}`,
        ),
    );
    if (uncovered.length) {
      throw new FullUransRequestCoverageIncompleteError(request.id, uncovered);
    }

    const linkedObligations = await tx
      .select({ obligation: simPrecalcObligations })
      .from(simPrecalcObligationRequests)
      .innerJoin(
        simPrecalcObligations,
        eq(simPrecalcObligations.id, simPrecalcObligationRequests.obligationId),
      )
      .where(
        and(
          eq(simPrecalcObligationRequests.requestId, request.id),
          sql`NOT EXISTS (
            SELECT 1
            FROM sim_urans_verify_queue_requests final_coverage
            JOIN sim_urans_verify_queue queue
              ON queue.id = final_coverage.queue_id
            WHERE final_coverage.request_id = ${request.id}
              AND queue.airfoil_id = ${simPrecalcObligations.airfoilId}
              AND queue.revision_id = ${simPrecalcObligations.revisionId}
              AND queue.aoa_deg = ${simPrecalcObligations.aoaDeg}
          )`,
        ),
      );
    const linkedQueueRows = await tx
      .select({ queueId: simUransVerifyQueueRequests.queueId })
      .from(simUransVerifyQueueRequests)
      .where(eq(simUransVerifyQueueRequests.requestId, request.id));
    return {
      requestId: request.id,
      totalCells: cells.length,
      precalcObligations: linkedObligations.map((row) => row.obligation),
      verifyQueueIds: linkedQueueRows.map((row) => row.queueId),
    };
  });
  if ("orphanedRequestId" in outcome) {
    throw new Error(
      `full URANS request ${outcome.orphanedRequestId} has no live owner`,
    );
  }
  return outcome;
}

export type FullUransRequestProjectedState =
  | "pending"
  | "running"
  | "done"
  | "blocked"
  | "cancelled";

/** Project an aggregate full request from its per-point child ledgers. A
 * satisfied preliminary cell is not complete until a linked final queue row
 * exists. Open children outrank blocked siblings so all recoverable points
 * continue before the aggregate becomes critically blocked. */
export async function fullUransRequestStateFromCoverage(
  tx: DB,
  requestId: string,
): Promise<FullUransRequestProjectedState> {
  const [summary] = (await tx.execute(sql`
    SELECT
      request.background_owner
      OR EXISTS (
        SELECT 1
        FROM sim_urans_request_campaigns ownership
        JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
        WHERE ownership.request_id = request.id
          AND ownership.state = 'active'
          AND campaign.status IN ('active', 'attention', 'paused')
      ) AS owner_live,
      EXISTS (
        SELECT 1
        FROM sim_precalc_obligation_requests coverage
        JOIN sim_precalc_obligations obligation
          ON obligation.id = coverage.obligation_id
        WHERE coverage.request_id = request.id
          AND obligation.state IN ('pending', 'running')
          AND NOT EXISTS (
            SELECT 1
            FROM sim_urans_verify_queue_requests verify_coverage
            JOIN sim_urans_verify_queue queue
              ON queue.id = verify_coverage.queue_id
            WHERE verify_coverage.request_id = request.id
              AND queue.airfoil_id = obligation.airfoil_id
              AND queue.revision_id = obligation.revision_id
              AND queue.aoa_deg = obligation.aoa_deg
          )
      ) AS preliminary_open,
      EXISTS (
        SELECT 1
        FROM sim_precalc_obligation_requests coverage
        JOIN sim_precalc_obligations obligation
          ON obligation.id = coverage.obligation_id
        WHERE coverage.request_id = request.id
          AND obligation.state = 'blocked'
          AND NOT EXISTS (
            SELECT 1
            FROM sim_urans_verify_queue_requests verify_coverage
            JOIN sim_urans_verify_queue queue
              ON queue.id = verify_coverage.queue_id
            WHERE verify_coverage.request_id = request.id
              AND queue.airfoil_id = obligation.airfoil_id
              AND queue.revision_id = obligation.revision_id
              AND queue.aoa_deg = obligation.aoa_deg
          )
      ) AS preliminary_blocked,
      EXISTS (
        SELECT 1
        FROM sim_precalc_obligation_requests coverage
        JOIN sim_precalc_obligations obligation
          ON obligation.id = coverage.obligation_id
        WHERE coverage.request_id = request.id
          AND NOT EXISTS (
            SELECT 1
            FROM sim_urans_verify_queue_requests verify_coverage
            JOIN sim_urans_verify_queue queue
              ON queue.id = verify_coverage.queue_id
            WHERE verify_coverage.request_id = request.id
              AND queue.airfoil_id = obligation.airfoil_id
              AND queue.revision_id = obligation.revision_id
              AND queue.aoa_deg = obligation.aoa_deg
          )
      ) AS preliminary_without_final,
      COALESCE(bool_or(queue.state IN ('pending', 'running')), false)
        AS final_open,
      COALESCE(bool_or(queue.state = 'blocked'), false) AS final_blocked,
      COALESCE(bool_or(queue.state = 'cancelled'), false) AS final_cancelled,
      count(queue.id)::int AS final_count,
      count(queue.id) FILTER (
        WHERE queue.state IN ('done', 'disagreed')
      )::int AS final_success_count
    FROM sim_urans_requests request
    LEFT JOIN sim_urans_verify_queue_requests final_coverage
      ON final_coverage.request_id = request.id
    LEFT JOIN sim_urans_verify_queue queue
      ON queue.id = final_coverage.queue_id
    WHERE request.id = ${requestId}
      AND request.fidelity = 'full'
    GROUP BY request.id
  `)) as unknown as Array<{
    owner_live: boolean;
    preliminary_open: boolean;
    preliminary_blocked: boolean;
    preliminary_without_final: boolean;
    final_open: boolean;
    final_blocked: boolean;
    final_cancelled: boolean;
    final_count: number;
    final_success_count: number;
  }>;
  if (!summary?.owner_live) return "cancelled";
  if (summary.preliminary_open) return "pending";
  if (summary.final_open) return "running";
  if (summary.preliminary_blocked || summary.final_blocked) return "blocked";
  if (summary.preliminary_without_final) return "pending";
  if (
    summary.final_count > 0 &&
    summary.final_success_count === summary.final_count
  ) {
    return "done";
  }
  if (summary.final_cancelled) return "pending";
  return "pending";
}

/** Transaction-safe aggregate projection for queue settlement/media-repair
 * paths. Queue transitions lock queue before request throughout the existing
 * lifecycle, so this helper deliberately takes no request lock before reading
 * child state and performs only the final fenced request update. */
export async function refreshFullUransRequestStateInTransaction(
  tx: DB,
  requestId: string,
): Promise<FullUransRequestProjectedState | null> {
  const [request] = await tx
    .select({
      fidelity: simUransRequests.fidelity,
      state: simUransRequests.state,
      simJobId: simUransRequests.simJobId,
    })
    .from(simUransRequests)
    .where(eq(simUransRequests.id, requestId))
    .limit(1);
  if (!request || request.fidelity !== "full") return null;
  if (request.state === "cancelled") return "cancelled";
  const state = await fullUransRequestStateFromCoverage(tx, requestId);
  const [activePhysicalJob] =
    state === "pending" && request.simJobId
      ? ((await tx.execute(sql`
          SELECT job.id
          FROM sim_jobs job
          WHERE job.id = ${request.simJobId}
            AND job.status IN ('pending', 'submitted', 'running', 'ingesting')
          LIMIT 1
        `)) as unknown as Array<{ id: string }>)
      : [];
  const projectedState = activePhysicalJob ? "running" : state;
  await tx
    .update(simUransRequests)
    .set({
      state: projectedState,
      simJobId: activePhysicalJob ? activePhysicalJob.id : null,
    })
    .where(
      and(
        eq(simUransRequests.id, requestId),
        eq(simUransRequests.fidelity, "full"),
        sql`${simUransRequests.state} <> 'cancelled'`,
        or(
          sql`${simUransRequests.state} IS DISTINCT FROM ${projectedState}`,
          activePhysicalJob
            ? sql`${simUransRequests.simJobId} IS DISTINCT FROM ${activePhysicalJob.id}`
            : sql`${simUransRequests.simJobId} IS NOT NULL`,
        ),
      ),
    );
  return projectedState;
}

export async function refreshFullUransRequestState(
  db: DB,
  requestId: string,
): Promise<FullUransRequestProjectedState | null> {
  return db.transaction((rawTx) =>
    refreshFullUransRequestStateInTransaction(
      rawTx as unknown as DB,
      requestId,
    ),
  );
}

export async function refreshFullUransRequestsForVerifyQueueInTransaction(
  tx: DB,
  queueId: string,
): Promise<string[]> {
  const links = await tx
    .select({ requestId: simUransVerifyQueueRequests.requestId })
    .from(simUransVerifyQueueRequests)
    .where(eq(simUransVerifyQueueRequests.queueId, queueId))
    .orderBy(asc(simUransVerifyQueueRequests.requestId));
  const refreshed: string[] = [];
  for (const link of links) {
    const state = await refreshFullUransRequestStateInTransaction(
      tx,
      link.requestId,
    );
    if (state) refreshed.push(link.requestId);
  }
  return refreshed;
}

export async function refreshFullUransRequestsForVerifyQueue(
  db: DB,
  queueId: string,
): Promise<string[]> {
  return db.transaction((rawTx) =>
    refreshFullUransRequestsForVerifyQueueInTransaction(
      rawTx as unknown as DB,
      queueId,
    ),
  );
}

// ---------------------------------------------------------------------------
// Ladder gates (contract 5).
// ---------------------------------------------------------------------------

/** A terminal/cancelled wave-1 parent can publish immutable RANS attempt
 * evidence before a canonical results row is installed. Such a cell is a
 * ladder obligation, not an unsolved RANS gap. Keep this expression shared by
 * the boolean gate and tier count so their answers cannot diverge. */
const ATTEMPT_BACKED_PRECALC_CELL_SQL = sql`EXISTS (
  SELECT 1
  FROM result_attempts ladder_attempt
  JOIN sim_jobs attempt_parent ON attempt_parent.id = ladder_attempt.sim_job_id
  LEFT JOIN result_classifications attempt_classification
    ON attempt_classification.result_attempt_id = ladder_attempt.id
  WHERE attempt_parent.campaign_id = p.campaign_id
    AND attempt_parent.wave = 1
    AND attempt_parent.status = 'cancelled'
    AND ladder_attempt.airfoil_id = p.airfoil_id
    AND ladder_attempt.simulation_preset_revision_id = p.revision_id
    AND ladder_attempt.aoa_deg = p.aoa_deg
    AND ladder_attempt.regime = 'rans'
    AND ladder_attempt.valid_for_polar = false
    AND (
      ladder_attempt.status = 'failed'
      OR attempt_classification.state IN ('needs_urans', 'rejected')
    )
)`;

/** Per-campaign precalc gate: URANS (precalc) work is gated while the campaign
 *  still has ANY open RANS gap. "Open RANS gap" mirrors the gap finder
 *  (findCampaignGapBatch): a requested, non-derived cell on a live condition
 *  that is still SCHEDULABLE as wave-1 work (no results row, or pending/
 *  stale), plus cells whose claim is held by an IN-FLIGHT wave-1 job (RANS
 *  still solving). A requested cell claimed by a wave-2 job — or left queued
 *  by a finished parent for its wave-2 child — is URANS work, not a RANS gap,
 *  so it must never gate the very retry that resolves it. */
export async function campaignHasOpenRansGaps(
  db: DB,
  campaignId: string,
): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT 1 FROM sim_campaign_points p
    JOIN sim_campaign_conditions c ON c.id = p.condition_id AND c.status IN ('active', 'kept')
    JOIN airfoils a ON a.id = p.airfoil_id
    LEFT JOIN results r
      ON r.airfoil_id = p.airfoil_id AND r.simulation_preset_revision_id = p.revision_id AND r.aoa_deg = p.aoa_deg
    LEFT JOIN sim_jobs j ON j.id = r.sim_job_id
    WHERE p.campaign_id = ${campaignId} AND p.state = 'requested'
      AND p.derived_by_symmetry = false
      AND NOT (a.is_symmetric AND p.aoa_deg < 0)
      AND (
        (
          (r.id IS NULL OR r.status IN ('pending', 'stale'))
          AND NOT (${ATTEMPT_BACKED_PRECALC_CELL_SQL})
        )
        OR (
          r.status IN ('queued', 'running')
          AND j.wave = 1
          AND j.status IN ('pending', 'submitted', 'running', 'ingesting')
        )
      )
    LIMIT 1
  `)) as unknown as unknown[];
  return rows.length > 0;
}

/** Idle-capacity verify gate: outside the bounded eight-RANS interleave,
 * verify-queue items schedule only when no campaign RANS/PRECALC work exists
 * anywhere — no open campaign gap, no pending admin request-URANS item, and no
 * in-flight non-verify campaign job. */
export async function hasOpenCampaignLadderWork(
  db: DB,
  scope: {
    requestIds?: string[];
    campaignIds?: string[];
    /** When false, a temporarily unavailable PRECALC capability must not make
     * unrelated full-fidelity verification look busy forever. Already-active
     * jobs still retain their normal lower-tier barrier. */
    includePrecalc?: boolean;
  } = {},
): Promise<boolean> {
  const includePrecalc = scope.includePrecalc !== false;
  const isolatedRequests = scope.requestIds !== undefined;
  const requestScope = !isolatedRequests
    ? sql``
    : scope.requestIds!.length
      ? sql`AND req.id = ANY(${sql`ARRAY[${sql.join(
          scope.requestIds!.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]`})`
      : sql`AND false`;
  const requestJobScope = !isolatedRequests
    ? sql``
    : scope.requestIds!.length
      ? sql`AND j.request_payload ->> 'uransRequestId' = ANY(${sql`ARRAY[${sql.join(
          scope.requestIds!.map((id) => sql`${id}`),
          sql`, `,
        )}]`}::text[])`
      : sql`AND false`;
  const requestFidelityScope = includePrecalc ? sql`` : sql`AND false`;
  const obligationCampaignScope = !includePrecalc
    ? sql`AND false`
    : scope.campaignIds === undefined
      ? sql``
      : scope.campaignIds.length
        ? sql`AND EXISTS (
        SELECT 1
        FROM sim_precalc_obligation_campaigns scoped_ownership
        WHERE scoped_ownership.obligation_id = obligation.id
          AND scoped_ownership.state = 'active'
          AND scoped_ownership.campaign_id = ANY(${sql`ARRAY[${sql.join(
            scope.campaignIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]`})
      )`
        : sql`AND false`;
  const [row] = (await db.execute(sql`
    SELECT
      ${
        isolatedRequests
          ? sql`false`
          : sql`EXISTS (
        SELECT 1 FROM sim_campaign_points p
        JOIN sim_campaigns camp ON camp.id = p.campaign_id AND camp.status = 'active'
        JOIN sim_campaign_conditions c ON c.id = p.condition_id AND c.status IN ('active', 'kept')
        WHERE p.state = 'requested'
      )`
      } AS rans_open,
      EXISTS (
        SELECT 1 FROM sim_urans_requests req
        WHERE req.state IN ('pending', 'running')
          ${requestScope}
          ${requestFidelityScope}
          AND NOT (
            req.fidelity = 'full'
            AND req.sim_job_id IS NULL
            AND EXISTS (
              SELECT 1
              FROM sim_urans_verify_queue_requests final_coverage
              JOIN sim_urans_verify_queue queue
                ON queue.id = final_coverage.queue_id
              WHERE final_coverage.request_id = req.id
                AND queue.state IN ('pending', 'running')
            )
            AND NOT EXISTS (
              SELECT 1
              FROM sim_precalc_obligation_requests preliminary_coverage
              JOIN sim_precalc_obligations obligation
                ON obligation.id = preliminary_coverage.obligation_id
              WHERE preliminary_coverage.request_id = req.id
                AND obligation.state IN ('pending', 'running')
                AND NOT EXISTS (
                  SELECT 1
                  FROM sim_urans_verify_queue_requests covered_final
                  JOIN sim_urans_verify_queue covered_queue
                    ON covered_queue.id = covered_final.queue_id
                  WHERE covered_final.request_id = req.id
                    AND covered_queue.airfoil_id = obligation.airfoil_id
                    AND covered_queue.revision_id = obligation.revision_id
                    AND covered_queue.aoa_deg = obligation.aoa_deg
                )
            )
          )
          AND (
            req.background_owner
            OR EXISTS (
              SELECT 1
              FROM sim_urans_request_campaigns ownership
              JOIN sim_campaigns owner ON owner.id = ownership.campaign_id
              WHERE ownership.request_id = req.id
                AND ownership.state = 'active'
                AND owner.status IN ('active', 'attention')
            )
          )
      ) AS requests_open,
      EXISTS (
        SELECT 1 FROM sim_precalc_obligations obligation
        WHERE obligation.state IN ('pending', 'running')
          ${obligationCampaignScope}
          AND (
            obligation.background_owner
            OR EXISTS (
              SELECT 1
              FROM sim_precalc_obligation_campaigns ownership
              JOIN sim_campaigns owner ON owner.id = ownership.campaign_id
              WHERE ownership.obligation_id = obligation.id
                AND ownership.state = 'active'
                AND owner.status IN ('active', 'attention')
            )
          )
      ) AS obligations_open,
      EXISTS (
        -- Keep verify below every in-flight precalc job, including the
        -- campaign_id=NULL physical job of a shared request. The request may
        -- already be marked done during ingest; the job remains the boundary
        -- until its own terminal write commits.
        SELECT 1 FROM sim_jobs j
        WHERE j.status IN ('pending', 'submitted', 'running', 'ingesting')
          AND j.job_kind <> 'verify'
          ${requestJobScope}
          AND (
            EXISTS (
              SELECT 1 FROM sim_campaigns camp
              WHERE camp.id = j.campaign_id
                AND camp.status IN ('active', 'attention')
            )
            OR (
              j.campaign_id IS NULL
              AND EXISTS (
                SELECT 1
                FROM sim_urans_requests linked_request
                WHERE linked_request.id::text = j.request_payload ->> 'uransRequestId'
                  AND (
                    linked_request.background_owner
                    OR EXISTS (
                      SELECT 1
                      FROM sim_urans_request_campaigns ownership
                      JOIN sim_campaigns owner_campaign ON owner_campaign.id = ownership.campaign_id
                      WHERE ownership.request_id = linked_request.id
                        AND ownership.state = 'active'
                        AND owner_campaign.status IN ('active', 'attention')
                    )
                  )
              )
            )
          )
      ) AS campaign_jobs_open
  `)) as unknown as {
    rans_open: boolean;
    requests_open: boolean;
    obligations_open: boolean;
    campaign_jobs_open: boolean;
  }[];
  return Boolean(
    row?.rans_open ||
    row?.requests_open ||
    row?.obligations_open ||
    row?.campaign_jobs_open,
  );
}

// ---------------------------------------------------------------------------
// Campaign tier counts + derived phase (contract 7 — DERIVED, no stored enum).
// ---------------------------------------------------------------------------
export interface CampaignTierCounts {
  /** Open RANS obligations: requested cells on live conditions. */
  ransOpen: number;
  /** Open precalc obligations: solved cells whose verdict is needs_urans (the
   *  RANS evidence demands an unsteady re-solve that has not superseded it
   *  yet) plus live cells currently re-solving under a wave-2 job. */
  precalcOpen: number;
  /** Open verification obligations: pending/running verify-queue items. */
  verifyOpen: number;
}

export async function campaignOpenTierCounts(
  db: DB,
  campaignId: string,
): Promise<CampaignTierCounts> {
  const [row] = (await db.execute(sql`
    SELECT
      (
        -- RANS tier: requested non-derived cells still on the wave-1 path —
        -- schedulable gaps (no row / pending / stale) or claims held by an
        -- in-flight wave-1 job (same shape as campaignHasOpenRansGaps).
        SELECT count(*) FROM sim_campaign_points p
        JOIN sim_campaign_conditions c ON c.id = p.condition_id AND c.status IN ('active', 'kept')
        JOIN airfoils a ON a.id = p.airfoil_id
        LEFT JOIN results r
          ON r.airfoil_id = p.airfoil_id AND r.simulation_preset_revision_id = p.revision_id AND r.aoa_deg = p.aoa_deg
        LEFT JOIN sim_jobs j ON j.id = r.sim_job_id
        WHERE p.campaign_id = ${campaignId} AND p.state = 'requested'
          AND p.derived_by_symmetry = false
          AND NOT (a.is_symmetric AND p.aoa_deg < 0)
          AND (
            (
              (r.id IS NULL OR r.status IN ('pending', 'stale'))
              AND NOT (${ATTEMPT_BACKED_PRECALC_CELL_SQL})
            )
            OR (r.status IN ('queued', 'running') AND j.wave = 1 AND j.status IN ('pending', 'submitted', 'running', 'ingesting'))
          )
      )::int AS rans_open,
      (
        -- One physical cell may be visible through several durable sources at
        -- once (classification, live wave-2 claim, automatic request, media
        -- repair). UNION the physical keys before counting so UI totals never
        -- inflate one point into two or three obligations.
        SELECT count(*)::int
        FROM (
          SELECT p.airfoil_id, p.revision_id, p.aoa_deg
          FROM sim_campaign_points p
          JOIN sim_campaign_conditions c ON c.id = p.condition_id AND c.status IN ('active', 'kept')
          LEFT JOIN result_classifications rc ON rc.result_id = p.result_id
          LEFT JOIN results live
            ON live.airfoil_id = p.airfoil_id
           AND live.simulation_preset_revision_id = p.revision_id
           AND live.aoa_deg = p.aoa_deg
          LEFT JOIN sim_jobs lj ON lj.id = live.sim_job_id
          WHERE p.campaign_id = ${campaignId}
            AND p.derived_by_symmetry = false
            AND (
              NOT EXISTS (
                SELECT 1 FROM sim_precalc_obligations known_obligation
                WHERE known_obligation.airfoil_id = p.airfoil_id
                  AND known_obligation.revision_id = p.revision_id
                  AND known_obligation.aoa_deg = p.aoa_deg
              )
              OR EXISTS (
                SELECT 1 FROM sim_precalc_obligations open_obligation
                WHERE open_obligation.airfoil_id = p.airfoil_id
                  AND open_obligation.revision_id = p.revision_id
                  AND open_obligation.aoa_deg = p.aoa_deg
                  AND open_obligation.state IN ('pending', 'running')
              )
            )
            AND (
              (
                p.state = 'terminal'
                AND (
                  rc.state = 'needs_urans'
                  OR (
                    rc.state = 'rejected'
                    AND live.status = 'done'
                    AND (
                      live.fidelity = 'rans'
                      OR (live.fidelity IS NULL AND live.regime IS DISTINCT FROM 'urans')
                    )
                  )
                )
              )
              OR (
                live.status IN ('queued', 'running')
                AND (lj.wave IS NULL OR lj.wave <> 1 OR lj.status IN ('done', 'failed', 'cancelled'))
              )
            )

          UNION

          SELECT obligation.airfoil_id, obligation.revision_id, obligation.aoa_deg
          FROM sim_precalc_obligation_campaigns ownership
          JOIN sim_precalc_obligations obligation
            ON obligation.id = ownership.obligation_id
          WHERE ownership.campaign_id = ${campaignId}
            AND ownership.state = 'active'
            AND obligation.state IN ('pending', 'running')

          UNION

          SELECT request_point.airfoil_id, request_point.revision_id, request_point.aoa_deg
          FROM sim_urans_request_campaigns ownership
          JOIN sim_urans_requests req ON req.id = ownership.request_id
          JOIN sim_campaign_points request_point
            ON request_point.campaign_id = ownership.campaign_id
           AND request_point.airfoil_id = req.airfoil_id
           AND request_point.revision_id = req.revision_id
           AND (req.aoa_deg IS NULL OR request_point.aoa_deg = req.aoa_deg)
           AND request_point.derived_by_symmetry = false
          WHERE ownership.campaign_id = ${campaignId}
            AND ownership.state = 'active'
            AND req.fidelity = 'precalc'
            AND req.state IN ('pending', 'running')

          UNION

          SELECT repair_point.airfoil_id, repair_point.revision_id, repair_point.aoa_deg
          FROM result_media_repairs repair
          JOIN results repair_result ON repair_result.id = repair.result_id
          JOIN sim_campaign_points repair_point ON repair_point.result_id = repair_result.id
          WHERE repair_point.campaign_id = ${campaignId}
            AND repair_point.derived_by_symmetry = false
            AND repair.state IN ('pending', 'running', 'retry_wait')
        ) physical_precalc_cell
      ) AS precalc_open,
      (
        SELECT count(DISTINCT q.id)
        FROM sim_urans_verify_queue q
        WHERE ${verifyQueueCampaignScopeSql(sql`q.id`, [campaignId])}
          AND q.state IN ('pending', 'running')
      )::int AS verify_open
  `)) as unknown as {
    rans_open: number;
    precalc_open: number;
    verify_open: number;
  }[];
  return {
    ransOpen: Number(row?.rans_open ?? 0),
    precalcOpen: Number(row?.precalc_open ?? 0),
    verifyOpen: Number(row?.verify_open ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Rolling-compatibility ladder buckets, derived live from one canonical SQL
// definition (no stored counters).
//
//   awaiting_urans — tier-1 rejects: terminal, non-derived, result DONE with a
//     'rejected' classification at fidelity 'rans' (NULL fidelity is a
//     pre-ladder RANS fallback only when regime is not explicitly URANS).
//     These are the stage-2 queue: calm violet, never red, no repair verbs.
//
//   needs_review — legacy wire key only. Its predicate is deliberately empty.
//     Machine failures, exhausted retries, rejected solver rows, and immutable
//     setup/media defects stay visible as failed/blocked/unavailable work; they
//     never become a coefficient-review chore merely because automation cannot
//     repair them.
//
// The point-history read model (point-history.ts) applies the SAME rule to
// raw results rows for the Points tab filters; both sides are pinned by the
// bucket-predicate matrix tests.
// ---------------------------------------------------------------------------
export interface CampaignReviewBuckets {
  awaitingUrans: number;
  needsReview: number;
}

export interface CampaignReviewBucketRow extends CampaignReviewBuckets {
  conditionId: string;
  airfoilId: string;
}

const AWAITING_URANS_POINT_SQL = sql`
  p.state = 'terminal' AND p.derived_by_symmetry = false
  AND r.status = 'done' AND rc.state = 'rejected'
  AND EXISTS (
    SELECT 1 FROM sim_precalc_obligations open_obligation
    WHERE open_obligation.airfoil_id = p.airfoil_id
      AND open_obligation.revision_id = p.revision_id
      AND open_obligation.aoa_deg = p.aoa_deg
      AND open_obligation.state IN ('pending', 'running')
  )
  AND (
    r.fidelity = 'rans'
    OR (r.fidelity IS NULL AND r.regime IS DISTINCT FROM 'urans')
  )`;

// Derived symmetry mirrors are excluded from BOTH arms: repairing the source
// point repairs its mirror and the Points tab bucket filters source rows only.
// `needs_review` is deliberately empty. A future human-adjudication workflow
// needs its own informed product decision; it must not be inferred from an
// automatic solver failure. Exhausted work stays rejected/failed/blocked: it
// is never auto-accepted and never becomes a coefficient-review chore.
const NEEDS_REVIEW_POINT_SQL = sql`FALSE`;

interface ReviewBucketQueryRow {
  condition_id: string;
  airfoil_id: string;
  awaiting_urans: number;
  needs_review: number;
}

/** Per-(condition, airfoil) rolling-compatibility ladder buckets. The coverage
 *  matrix and summary consume the same canonical query. */
export async function campaignReviewBucketRows(
  db: DB,
  campaignId: string,
  opts: { airfoilIds?: string[] } = {},
): Promise<CampaignReviewBucketRow[]> {
  const airfoilFilter = opts.airfoilIds?.length
    ? sql`AND p.airfoil_id = ANY(${sql`ARRAY[${sql.join(
        opts.airfoilIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]`})`
    : sql``;
  const rows = (await db.execute(sql`
    SELECT p.condition_id, p.airfoil_id,
      COUNT(*) FILTER (WHERE ${AWAITING_URANS_POINT_SQL})::int AS awaiting_urans,
      COUNT(*) FILTER (WHERE ${NEEDS_REVIEW_POINT_SQL})::int AS needs_review
    FROM sim_campaign_points p
    JOIN sim_campaign_conditions condition ON condition.id = p.condition_id
    JOIN sim_campaigns campaign ON campaign.id = p.campaign_id
    LEFT JOIN results r ON r.id = p.result_id
    LEFT JOIN result_classifications rc ON rc.result_id = p.result_id
    WHERE p.campaign_id = ${campaignId}
      AND condition.generation = campaign.current_condition_generation
      AND condition.status IN ('active', 'kept')
      ${airfoilFilter}
    GROUP BY p.condition_id, p.airfoil_id
    HAVING COUNT(*) FILTER (WHERE ${AWAITING_URANS_POINT_SQL}) > 0
        OR COUNT(*) FILTER (WHERE ${NEEDS_REVIEW_POINT_SQL}) > 0
  `)) as unknown as ReviewBucketQueryRow[];
  return rows.map((row) => ({
    conditionId: row.condition_id,
    airfoilId: row.airfoil_id,
    awaitingUrans: Number(row.awaiting_urans),
    needsReview: Number(row.needs_review),
  }));
}

/** Whole-campaign rolling-compatibility ladder totals. */
export async function campaignReviewBuckets(
  db: DB,
  campaignId: string,
): Promise<CampaignReviewBuckets> {
  const [row] = (await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE ${AWAITING_URANS_POINT_SQL})::int AS awaiting_urans,
      COUNT(*) FILTER (WHERE ${NEEDS_REVIEW_POINT_SQL})::int AS needs_review
    FROM sim_campaign_points p
    JOIN sim_campaign_conditions condition ON condition.id = p.condition_id
    JOIN sim_campaigns campaign ON campaign.id = p.campaign_id
    LEFT JOIN results r ON r.id = p.result_id
    LEFT JOIN result_classifications rc ON rc.result_id = p.result_id
    WHERE p.campaign_id = ${campaignId}
      AND condition.generation = campaign.current_condition_generation
      AND condition.status IN ('active', 'kept')
  `)) as unknown as Array<{ awaiting_urans: number; needs_review: number }>;
  return {
    awaitingUrans: Number(row?.awaiting_urans ?? 0),
    needsReview: Number(row?.needs_review ?? 0),
  };
}

/** Batched rolling-compatibility buckets for a campaign list payload.
 *  Campaigns without any bucketed point are absent from the map. */
export async function reviewBucketsByCampaign(
  db: DB,
  campaignIds: string[],
): Promise<Map<string, CampaignReviewBuckets>> {
  if (!campaignIds.length) return new Map();
  const rows = (await db.execute(sql`
    SELECT p.campaign_id,
      COUNT(*) FILTER (WHERE ${AWAITING_URANS_POINT_SQL})::int AS awaiting_urans,
      COUNT(*) FILTER (WHERE ${NEEDS_REVIEW_POINT_SQL})::int AS needs_review
    FROM sim_campaign_points p
    JOIN sim_campaign_conditions condition ON condition.id = p.condition_id
    JOIN sim_campaigns campaign ON campaign.id = p.campaign_id
    LEFT JOIN results r ON r.id = p.result_id
    LEFT JOIN result_classifications rc ON rc.result_id = p.result_id
    WHERE p.campaign_id = ANY(${sql`ARRAY[${sql.join(
      campaignIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}]`})
      AND condition.generation = campaign.current_condition_generation
      AND condition.status IN ('active', 'kept')
    GROUP BY p.campaign_id
  `)) as unknown as Array<{
    campaign_id: string;
    awaiting_urans: number;
    needs_review: number;
  }>;
  return new Map(
    rows.map((row) => [
      row.campaign_id,
      {
        awaitingUrans: Number(row.awaiting_urans),
        needsReview: Number(row.needs_review),
      },
    ]),
  );
}

export type CampaignPhase =
  | "running_rans"
  | "running_precalc"
  | "running_refinement"
  | "completed"
  | null;

/** Derived campaign phase (contract 7): running_rans → running_precalc →
 *  running_refinement → completed. Pure. Non-running statuses (paused,
 *  cancelled, archived) have no ladder phase; `attention`/`completed` report
 *  their own status truthfully (phase only decorates an active ladder). */
export function deriveCampaignPhase(
  status: string,
  tiers: CampaignTierCounts,
): CampaignPhase {
  if (status === "completed") return "completed";
  if (status !== "active" && status !== "attention") return null;
  if (tiers.ransOpen > 0) return "running_rans";
  if (tiers.precalcOpen > 0) return "running_precalc";
  if (tiers.verifyOpen > 0) return "running_refinement";
  return status === "active" ? "completed" : null;
}

// ---------------------------------------------------------------------------
// Queue/request accessors used by the sweeper ladder tick.
// ---------------------------------------------------------------------------
function linkedFullRequestOwnerSql(
  queueId: string | SQLWrapper,
  includePaused = false,
) {
  const campaignStates = includePaused
    ? sql`('active', 'attention', 'paused')`
    : sql`('active', 'attention')`;
  return sql`EXISTS (
    SELECT 1
    FROM sim_urans_verify_queue_requests coverage
    JOIN sim_urans_requests request ON request.id = coverage.request_id
    WHERE coverage.queue_id = ${queueId}
      AND request.fidelity = 'full'
      AND request.state IN ('pending', 'running')
      AND (
        request.background_owner
        OR EXISTS (
          SELECT 1
          FROM sim_urans_request_campaigns ownership
          JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
          WHERE ownership.request_id = request.id
            AND ownership.state = 'active'
            AND campaign.status IN ${campaignStates}
        )
      )
  )`;
}

function verifyQueueLiveOwnerSql(
  queueId: string | SQLWrapper,
  includePaused = false,
) {
  const campaignStates = includePaused
    ? sql`('active', 'attention', 'paused')`
    : sql`('active', 'attention')`;
  return sql`(
    EXISTS (
      SELECT 1
      FROM sim_urans_verify_queue owned_queue
      WHERE owned_queue.id = ${queueId}
        AND owned_queue.background_owner
    )
    OR EXISTS (
      SELECT 1
      FROM sim_urans_verify_queue_campaigns ownership
      JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
      WHERE ownership.queue_id = ${queueId}
        AND ownership.state = 'active'
        AND campaign.status IN ${campaignStates}
    )
    OR ${linkedFullRequestOwnerSql(queueId, includePaused)}
  )`;
}

function verifyQueueCampaignScopeSql(
  queueId: string | SQLWrapper,
  campaignIds: string[],
  requireOpenRequest = true,
) {
  if (!campaignIds.length) return sql`false`;
  const ids = sql`ARRAY[${sql.join(
    campaignIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]`;
  return sql`(
    EXISTS (
      SELECT 1
      FROM sim_urans_verify_queue_campaigns scoped_owner
      WHERE scoped_owner.queue_id = ${queueId}
        AND scoped_owner.state = 'active'
        AND scoped_owner.campaign_id = ANY(${ids})
    )
    OR EXISTS (
      SELECT 1
      FROM sim_urans_verify_queue_requests coverage
      JOIN sim_urans_requests request ON request.id = coverage.request_id
      JOIN sim_urans_request_campaigns scoped_owner
        ON scoped_owner.request_id = request.id
      WHERE coverage.queue_id = ${queueId}
        AND request.fidelity = 'full'
        ${requireOpenRequest ? sql`AND request.state IN ('pending', 'running')` : sql``}
        AND scoped_owner.state = 'active'
        AND scoped_owner.campaign_id = ANY(${ids})
    )
  )`;
}

export interface PendingVerifyScope {
  /** Test-harness isolation for the shared dev DB. Production omits this and
   *  considers the global queue. */
  campaignIds?: string[];
  /** Test-only physical-item scope for background-owned rows, which have no
   * campaign association to isolate parallel files. Production omits this. */
  verifyIds?: string[];
  /** Rolling engine cutover gate. False keeps newly reopened continuation and
   * corrective-fresh recovery pending while still allowing an initial final
   * verification (and an ordinary transport retry) to be scheduled. */
  allowAutomaticRecovery?: boolean;
}

function verifyRecoveryScopeSql(scope: PendingVerifyScope) {
  return scope.allowAutomaticRecovery === false
    ? sql`AND q.fresh_attempt_count = 0
      AND q.continuation_attempt_count = 0
      AND COALESCE(q.last_outcome, '') NOT IN (
          ${FINAL_URANS_OUTCOMES.continuationPending},
          ${FINAL_URANS_OUTCOMES.continuationRetryWait},
          ${FINAL_URANS_OUTCOMES.freshRetryPending}
        )`
    : sql``;
}

/** A pending final-verification item cannot sit behind an unbounded wave-1
 * backlog. The scheduler admits at most this many new RANS jobs after the
 * oldest schedulable pending item (or the latest successfully admitted verify,
 * whichever is newer) before final verification owns the next eligible slot. */
export const MAX_WAVE1_ADMISSIONS_BEFORE_VERIFY = 8;

export interface VerifyInterleaveScope extends PendingVerifyScope {
  /** Test-only closed history for files sharing one live dev database.
   * Production omits this and counts every successfully admitted wave-1 job. */
  wave1JobIds?: string[];
}

export interface VerifyInterleaveDecision {
  due: boolean;
  pendingSince: Date | null;
  latestVerifySubmittedAt: Date | null;
  opportunitySince: Date | null;
  wave1AdmissionsSinceOpportunity: number;
}

/** Restart-safe final-verification fairness derived entirely from durable DB
 * history. No process-local counter is authoritative: after a restart, the
 * oldest runnable verify item, latest accepted verify submission, and wave-1
 * submittedAt history reconstruct the exact same decision.
 *
 * Only successful engine admissions count. Pending compositions and answered
 * submit failures have submittedAt=NULL and therefore cannot spend the bounded
 * RANS allowance. The bounded subquery stops once the threshold is reached. */
export async function finalVerifyInterleaveDecision(
  db: DB,
  scope: VerifyInterleaveScope = {},
): Promise<VerifyInterleaveDecision> {
  const campaignScopeSql =
    scope.campaignIds === undefined
      ? sql``
      : scope.campaignIds.length
        ? sql`AND ${verifyQueueCampaignScopeSql(sql`q.id`, scope.campaignIds)}`
        : sql`AND false`;
  const verifyScopeSql =
    scope.verifyIds === undefined
      ? sql``
      : scope.verifyIds.length
        ? sql`AND q.id = ANY(${sql`ARRAY[${sql.join(
            scope.verifyIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]`})`
        : sql`AND false`;
  const latestVerifyScopeSql =
    scope.verifyIds === undefined
      ? scope.campaignIds === undefined
        ? sql``
        : scope.campaignIds.length
          ? sql`AND ${verifyQueueCampaignScopeSql(
              sql`(verify_job.request_payload ->> 'verifyQueueItemId')::uuid`,
              scope.campaignIds,
              false,
            )}`
          : sql`AND false`
      : scope.verifyIds.length
        ? sql`AND verify_job.request_payload ->> 'verifyQueueItemId' =
          ANY(${sql`ARRAY[${sql.join(
            scope.verifyIds.map((id) => sql`${id}`),
            sql`, `,
          )}]`}::text[])`
        : sql`AND false`;
  const wave1ScopeSql =
    scope.wave1JobIds === undefined
      ? scope.campaignIds === undefined
        ? sql``
        : scope.campaignIds.length
          ? sql`AND wave1.campaign_id = ANY(${sql`ARRAY[${sql.join(
              scope.campaignIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )}]`})`
          : sql`AND false`
      : scope.wave1JobIds.length
        ? sql`AND wave1.id = ANY(${sql`ARRAY[${sql.join(
            scope.wave1JobIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]`})`
        : sql`AND false`;

  const recoveryScopeSql = verifyRecoveryScopeSql(scope);
  const [row] = (await db.execute(sql`
    WITH oldest_pending AS (
      SELECT MIN(q."createdAt") AS pending_since
      FROM sim_urans_verify_queue q
      WHERE q.state = 'pending'
        AND (q.next_submit_at IS NULL OR q.next_submit_at <= now())
        AND COALESCE(q.last_outcome, '') <> ${FINAL_URANS_OUTCOMES.mediaRepairPending}
        ${recoveryScopeSql}
        ${campaignScopeSql}
        ${verifyScopeSql}
        AND NOT EXISTS (
          SELECT 1
          FROM sim_ladder_submit_retries submit_retry
          WHERE submit_retry.verify_queue_id = q.id
            AND (
              submit_retry.state = 'blocked'
              OR submit_retry.next_attempt_at > now()
            )
        )
        AND ${verifyQueueLiveOwnerSql(sql`q.id`)}
    ),
    latest_verify AS (
      SELECT MAX(verify_job."submittedAt") AS latest_verify_submitted_at
      FROM sim_jobs verify_job
      WHERE verify_job.job_kind = 'verify'
        AND verify_job."submittedAt" IS NOT NULL
        ${latestVerifyScopeSql}
    ),
    opportunity AS (
      SELECT
        oldest_pending.pending_since,
        latest_verify.latest_verify_submitted_at,
        CASE
          WHEN oldest_pending.pending_since IS NULL THEN NULL
          ELSE GREATEST(
            oldest_pending.pending_since,
            COALESCE(
              latest_verify.latest_verify_submitted_at,
              oldest_pending.pending_since
            )
          )
        END AS opportunity_since
      FROM oldest_pending
      CROSS JOIN latest_verify
    ),
    bounded_wave1_admissions AS (
      SELECT COUNT(*)::int AS admission_count
      FROM (
        SELECT 1
        FROM sim_jobs wave1
        CROSS JOIN opportunity
        WHERE opportunity.opportunity_since IS NOT NULL
          AND wave1.wave = 1
          AND wave1.job_kind <> 'verify'
          AND wave1."submittedAt" IS NOT NULL
          AND wave1."submittedAt" > opportunity.opportunity_since
          ${wave1ScopeSql}
        LIMIT ${MAX_WAVE1_ADMISSIONS_BEFORE_VERIFY}
      ) admitted
    )
    SELECT
      opportunity.pending_since,
      opportunity.latest_verify_submitted_at,
      opportunity.opportunity_since,
      bounded_wave1_admissions.admission_count
    FROM opportunity
    CROSS JOIN bounded_wave1_admissions
  `)) as unknown as Array<{
    pending_since: Date | string | null;
    latest_verify_submitted_at: Date | string | null;
    opportunity_since: Date | string | null;
    admission_count: number;
  }>;

  const asDate = (value: Date | string | null | undefined) =>
    value == null ? null : value instanceof Date ? value : new Date(value);
  const wave1AdmissionsSinceOpportunity = Number(row?.admission_count ?? 0);
  const pendingSince = asDate(row?.pending_since);
  return {
    due:
      pendingSince != null &&
      wave1AdmissionsSinceOpportunity >= MAX_WAVE1_ADMISSIONS_BEFORE_VERIFY,
    pendingSince,
    latestVerifySubmittedAt: asDate(row?.latest_verify_submitted_at),
    opportunitySince: asDate(row?.opportunity_since),
    wave1AdmissionsSinceOpportunity,
  };
}

export async function nextPendingVerifyItem(
  db: DB,
  scope: PendingVerifyScope = {},
): Promise<SimUransVerifyQueueItem | null> {
  const scopeSql =
    scope.campaignIds === undefined
      ? sql``
      : scope.campaignIds.length
        ? sql`AND ${verifyQueueCampaignScopeSql(sql`q.id`, scope.campaignIds)}`
        : sql`AND false`;
  const verifyScopeSql =
    scope.verifyIds === undefined
      ? sql``
      : scope.verifyIds.length
        ? sql`AND q.id = ANY(${sql`ARRAY[${sql.join(
            scope.verifyIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]`})`
        : sql`AND false`;
  const recoveryScopeSql = verifyRecoveryScopeSql(scope);
  const [candidate] = (await db.execute(sql`
    SELECT q.id
    FROM sim_urans_verify_queue q
    WHERE q.state = 'pending'
      AND (q.next_submit_at IS NULL OR q.next_submit_at <= now())
      AND COALESCE(q.last_outcome, '') <> ${FINAL_URANS_OUTCOMES.mediaRepairPending}
      ${recoveryScopeSql}
      ${scopeSql}
      ${verifyScopeSql}
      AND NOT EXISTS (
        SELECT 1 FROM sim_ladder_submit_retries submit_retry
        WHERE submit_retry.verify_queue_id = q.id
          AND (
            submit_retry.state = 'blocked'
            OR submit_retry.next_attempt_at > now()
          )
      )
      AND ${verifyQueueLiveOwnerSql(sql`q.id`)}
    ORDER BY q."createdAt" ASC
    LIMIT 1
  `)) as unknown as Array<{ id: string }>;
  if (!candidate) return null;
  const [item] = await db
    .select()
    .from(simUransVerifyQueue)
    .where(eq(simUransVerifyQueue.id, candidate.id))
    .limit(1);
  return item ?? null;
}

/** Atomically claim the next schedulable verify item before engine work.
 * Lifecycle verbs lock campaign first, so claim follows the same order:
 * optimistic queue read -> campaign SHARE -> conditional pending→running.
 * Two claimers may read one candidate, but only one conditional update wins. */
export async function claimNextPendingVerifyItem(
  db: DB,
  scope: PendingVerifyScope = {},
): Promise<SimUransVerifyQueueItem | null> {
  return db.transaction(async (tx) => {
    const scopeSql =
      scope.campaignIds === undefined
        ? sql``
        : scope.campaignIds.length
          ? sql`AND ${verifyQueueCampaignScopeSql(
              sql`q.id`,
              scope.campaignIds,
            )}`
          : sql`AND false`;
    const verifyScopeSql =
      scope.verifyIds === undefined
        ? sql``
        : scope.verifyIds.length
          ? sql`AND q.id = ANY(${sql`ARRAY[${sql.join(
              scope.verifyIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )}]`})`
          : sql`AND false`;
    const recoveryScopeSql = verifyRecoveryScopeSql(scope);
    const [candidate] = (await tx.execute(sql`
      SELECT q.id
      FROM sim_urans_verify_queue q
      WHERE q.state = 'pending'
        AND (q.next_submit_at IS NULL OR q.next_submit_at <= now())
        AND COALESCE(q.last_outcome, '') <> ${FINAL_URANS_OUTCOMES.mediaRepairPending}
        ${recoveryScopeSql}
        ${scopeSql}
        ${verifyScopeSql}
        AND NOT EXISTS (
          SELECT 1 FROM sim_ladder_submit_retries submit_retry
          WHERE submit_retry.verify_queue_id = q.id
            AND (
              submit_retry.state = 'blocked'
              OR submit_retry.next_attempt_at > now()
            )
        )
        AND ${verifyQueueLiveOwnerSql(sql`q.id`)}
      ORDER BY q."createdAt" ASC
      LIMIT 1
    `)) as unknown as Array<{ id: string }>;
    if (!candidate) return null;
    // Match campaign lifecycle's campaign-row lock order. Background-owned
    // work needs no campaign lock; shared work locks every currently-live
    // owner before the conditional state transition.
    await tx.execute(sql`
      SELECT campaign.id
      FROM sim_campaigns campaign
      WHERE campaign.id IN (
        SELECT ownership.campaign_id
        FROM sim_urans_verify_queue_campaigns ownership
        WHERE ownership.queue_id = ${candidate.id}
          AND ownership.state = 'active'
        UNION
        SELECT request_ownership.campaign_id
        FROM sim_urans_verify_queue_requests coverage
        JOIN sim_urans_requests request ON request.id = coverage.request_id
        JOIN sim_urans_request_campaigns request_ownership
          ON request_ownership.request_id = request.id
        WHERE coverage.queue_id = ${candidate.id}
          AND request.fidelity = 'full'
          AND request.state IN ('pending', 'running')
          AND request_ownership.state = 'active'
      )
        AND campaign.status IN ('active', 'attention')
      ORDER BY campaign.id
      FOR SHARE OF campaign
    `);
    const [claimed] = await tx
      .update(simUransVerifyQueue)
      // A new execution claim invalidates every historical job binding. The
      // composer installs the exact new sim_job_id before external submit.
      .set({ state: "running", simJobId: null })
      .where(
        and(
          eq(simUransVerifyQueue.id, candidate.id),
          eq(simUransVerifyQueue.state, "pending"),
          or(
            isNull(simUransVerifyQueue.nextSubmitAt),
            sql`${simUransVerifyQueue.nextSubmitAt} <= now()`,
          ),
          sql`COALESCE(${simUransVerifyQueue.lastOutcome}, '') <> ${FINAL_URANS_OUTCOMES.mediaRepairPending}`,
          ...(scope.allowAutomaticRecovery === false
            ? [
                sql`${simUransVerifyQueue.freshAttemptCount} = 0`,
                sql`${simUransVerifyQueue.continuationAttemptCount} = 0`,
                sql`COALESCE(${simUransVerifyQueue.lastOutcome}, '') NOT IN (
                    ${FINAL_URANS_OUTCOMES.continuationPending},
                    ${FINAL_URANS_OUTCOMES.continuationRetryWait},
                    ${FINAL_URANS_OUTCOMES.freshRetryPending}
                  )`,
              ]
            : []),
          ...(scope.verifyIds === undefined
            ? []
            : scope.verifyIds.length
              ? [inArray(simUransVerifyQueue.id, scope.verifyIds)]
              : [sql`false`]),
          sql`NOT EXISTS (
            SELECT 1 FROM sim_ladder_submit_retries submit_retry
            WHERE submit_retry.verify_queue_id = ${simUransVerifyQueue.id}
              AND (
                submit_retry.state = 'blocked'
                OR submit_retry.next_attempt_at > now()
              )
          )`,
          verifyQueueLiveOwnerSql(simUransVerifyQueue.id),
        ),
      )
      .returning();
    return claimed ?? null;
  });
}

/** Release a pre-submit verify claim after a transient engine connection
 *  failure. Paused work freezes as pending for resume; terminal campaign work
 *  becomes cancelled instead of being resurrected into a hidden pending row. */
const VERIFY_CLAIM_RELEASE_STATE_SQL = sql`CASE
  WHEN ${verifyQueueLiveOwnerSql(sql`q.id`, true)} THEN 'pending'
  ELSE 'cancelled'
END`;

export async function releaseClaimedVerifyItem(
  db: DB,
  itemId: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE sim_urans_verify_queue q
    SET state = ${VERIFY_CLAIM_RELEASE_STATE_SQL},
        sim_job_id = NULL,
        "updatedAt" = now()
    WHERE q.id = ${itemId} AND q.state = 'running'
  `);
}

export async function nextPendingUransRequest(
  db: DB,
): Promise<SimUransRequest | null> {
  const [candidate] = (await db.execute(sql`
    SELECT req.id
    FROM sim_urans_requests req
    WHERE req.state = 'pending'
      AND (
        req.fidelity = 'full'
        OR NOT EXISTS (
          SELECT 1 FROM sim_ladder_submit_retries submit_retry
          WHERE submit_retry.urans_request_id = req.id
            AND (
              submit_retry.state = 'blocked'
              OR submit_retry.next_attempt_at > now()
            )
        )
      )
      AND (
        req.background_owner
        OR EXISTS (
          SELECT 1
          FROM sim_urans_request_campaigns ownership
          JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
          WHERE ownership.request_id = req.id
            AND ownership.state = 'active'
            AND campaign.status IN ('active', 'attention')
        )
      )
    ORDER BY req."createdAt" ASC
    LIMIT 1
  `)) as unknown as Array<{ id: string }>;
  if (!candidate) return null;
  const [request] = await db
    .select()
    .from(simUransRequests)
    .where(eq(simUransRequests.id, candidate.id))
    .limit(1);
  return request ?? null;
}

export interface PendingUransRequestScope {
  /** Test-harness isolation for the shared dev DB. Production omits this. */
  requestIds?: string[];
  /** Capability-aware lane selection. Undefined keeps the ordinary mixed
   * oldest-first queue; `full` lets full work proceed while PRECALC is gated. */
  fidelity?: "precalc" | "full";
}

/** Atomically claim one request before composition or external submit.
 * Campaign ownership follows the lifecycle lock order: optimistic request
 * read -> campaign SHARE -> conditional pending→running. Campaign-only
 * requests are eligible only with a live owner; background-owned requests
 * remain independently runnable regardless of their original creator. */
export async function claimNextPendingUransRequest(
  db: DB,
  scope: PendingUransRequestScope = {},
): Promise<SimUransRequest | null> {
  return db.transaction(async (tx) => {
    const requestScope =
      scope.requestIds === undefined
        ? sql``
        : scope.requestIds.length
          ? sql`AND req.id = ANY(${sql`ARRAY[${sql.join(
              scope.requestIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )}]`})`
          : sql`AND false`;
    const fidelityScope = scope.fidelity
      ? sql`AND req.fidelity = ${scope.fidelity}`
      : sql``;
    const [candidate] = (await tx.execute(sql`
      SELECT req.id, req.background_owner
      FROM sim_urans_requests req
      WHERE req.state = 'pending'
        ${requestScope}
        ${fidelityScope}
        AND (
          req.fidelity = 'full'
          OR NOT EXISTS (
            SELECT 1 FROM sim_ladder_submit_retries submit_retry
            WHERE submit_retry.urans_request_id = req.id
              AND (
                submit_retry.state = 'blocked'
                OR submit_retry.next_attempt_at > now()
              )
          )
        )
        AND (
          req.background_owner
          OR EXISTS (
            SELECT 1
            FROM sim_urans_request_campaigns ownership
            JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
            WHERE ownership.request_id = req.id
              AND ownership.state = 'active'
              AND campaign.status IN ('active', 'attention')
          )
        )
      ORDER BY req."createdAt" ASC
      LIMIT 1
    `)) as unknown as Array<{ id: string; background_owner: boolean }>;
    if (!candidate) return null;
    if (!candidate.background_owner) {
      await tx.execute(sql`
        SELECT campaign.id
        FROM sim_urans_request_campaigns ownership
        JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
        WHERE ownership.request_id = ${candidate.id}
          AND ownership.state = 'active'
          AND campaign.status IN ('active', 'attention')
        ORDER BY campaign.id
        FOR SHARE OF campaign
      `);
    }
    const [claimed] = await tx
      .update(simUransRequests)
      .set({ state: "running", simJobId: null })
      .where(
        and(
          eq(simUransRequests.id, candidate.id),
          eq(simUransRequests.state, "pending"),
          sql`(
            ${simUransRequests.fidelity} = 'full'
            OR NOT EXISTS (
              SELECT 1 FROM sim_ladder_submit_retries submit_retry
              WHERE submit_retry.urans_request_id = ${simUransRequests.id}
                AND (
                  submit_retry.state = 'blocked'
                  OR submit_retry.next_attempt_at > now()
                )
            )
          )`,
          sql`(
            ${simUransRequests.backgroundOwner}
            OR EXISTS (
              SELECT 1
              FROM sim_urans_request_campaigns ownership
              JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
              WHERE ownership.request_id = ${simUransRequests.id}
                AND ownership.state = 'active'
                AND campaign.status IN ('active', 'attention')
            )
          )`,
        ),
      )
      .returning();
    return claimed ?? null;
  });
}

const REQUEST_CLAIM_RELEASE_STATE_SQL = sql`CASE
  WHEN req.background_owner THEN 'pending'
  WHEN EXISTS (
    SELECT 1
    FROM sim_urans_request_campaigns ownership
    JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
    WHERE ownership.request_id = req.id
      AND ownership.state = 'active'
      AND campaign.status IN ('active', 'attention', 'paused')
  ) THEN 'pending'
  ELSE 'cancelled'
END`;

export async function releaseClaimedUransRequest(
  db: DB,
  requestId: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE sim_urans_requests req
    SET state = ${REQUEST_CLAIM_RELEASE_STATE_SQL}, sim_job_id = NULL,
        "updatedAt" = now()
    WHERE req.id = ${requestId} AND req.state = 'running'
  `);
}

/** Heal verify items stuck 'running' whose composing/solving job died without
 * settling them (job cancelled/lost/failed before ingest). Live/paused/public
 * work returns to pending; terminal campaign work becomes cancelled. A live
 * job referencing the item keeps it running. */
export async function healOrphanedVerifyItems(
  db: DB,
  scope: PendingVerifyScope = {},
): Promise<number> {
  const scopeSql =
    scope.campaignIds === undefined
      ? sql``
      : scope.campaignIds.length
        ? sql`AND ${verifyQueueCampaignScopeSql(sql`q.id`, scope.campaignIds)}`
        : sql`AND false`;
  const verifyScopeSql =
    scope.verifyIds === undefined
      ? sql``
      : scope.verifyIds.length
        ? sql`AND q.id = ANY(${sql`ARRAY[${sql.join(
            scope.verifyIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]`})`
        : sql`AND false`;
  return db.transaction(async (tx) => {
    // Pending physical work with neither a background owner nor a currently
    // live/frozen campaign owner is terminal, not a hidden queue entry. Lock
    // the source result as well as the queue row: every production association
    // creator holds that same result lock until its owner row is inserted, so
    // SKIP LOCKED defers rather than racing campaign launch/plan growth.
    const pendingCandidates = (await tx.execute(sql`
      SELECT q.id
      FROM sim_urans_verify_queue q
      JOIN results source_result ON source_result.id = q.precalc_result_id
      WHERE q.state = 'pending'
        ${scopeSql}
        ${verifyScopeSql}
        AND NOT ${verifyQueueLiveOwnerSql(sql`q.id`, true)}
      ORDER BY q."createdAt", q.id
      LIMIT 100
      FOR UPDATE OF q, source_result SKIP LOCKED
    `)) as unknown as Array<{ id: string }>;
    let pendingCancelled = 0;
    if (pendingCandidates.length) {
      const cancelled = (await tx.execute(sql`
        UPDATE sim_urans_verify_queue q
        SET state = 'cancelled', sim_job_id = NULL, "updatedAt" = now()
        WHERE q.id = ANY(${sql`ARRAY[${sql.join(
          pendingCandidates.map((row) => sql`${row.id}::uuid`),
          sql`, `,
        )}]`})
          AND q.state = 'pending'
          AND NOT ${verifyQueueLiveOwnerSql(sql`q.id`, true)}
        RETURNING q.id
      `)) as unknown as Array<{ id: string }>;
      pendingCancelled = cancelled.length;
    }

    // A five-minute-old pending job is beyond the engine client's bounded
    // 60-second submit timeout. Cancel it conditionally; a concurrent
    // pending→submitted winner makes PostgreSQL recheck and preserves it.
    await tx.execute(sql`
      UPDATE sim_jobs j
      SET status = 'cancelled', engine_state = 'cancelled',
          error = 'orphaned verify composition recovered before engine submission',
          "finishedAt" = now(), "updatedAt" = now()
      FROM sim_urans_verify_queue q
      WHERE q.state = 'running'
        ${scopeSql}
        ${verifyScopeSql}
        AND q."updatedAt" < now() - interval '5 minutes'
        AND j.status = 'pending'
        AND j."updatedAt" < now() - interval '5 minutes'
        AND q.sim_job_id = j.id
        AND j.request_payload ->> 'verifyQueueItemId' = q.id::text
    `);
    const rows = (await tx.execute(sql`
      UPDATE sim_urans_verify_queue q
      SET state = ${VERIFY_CLAIM_RELEASE_STATE_SQL}, sim_job_id = NULL,
          "updatedAt" = now()
      WHERE q.state = 'running'
        ${scopeSql}
        ${verifyScopeSql}
        AND NOT EXISTS (
          SELECT 1 FROM sim_jobs j
          WHERE j.status IN ('pending', 'submitted', 'running', 'ingesting')
            AND j.id = q.sim_job_id
        )
        AND q."updatedAt" < now() - interval '5 minutes'
      RETURNING q.id
    `)) as unknown as { id: string }[];
    return pendingCancelled + rows.length;
  });
}

/** Heal admin requests stuck 'running' after their job vanished (cancelled /
 *  lost / deleted): back to pending for a re-attempt. */
export async function healOrphanedUransRequests(
  db: DB,
  scope: PendingUransRequestScope = {},
): Promise<number> {
  const requestScope =
    scope.requestIds === undefined
      ? sql``
      : scope.requestIds.length
        ? sql`AND req.id = ANY(${sql`ARRAY[${sql.join(
            scope.requestIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]`})`
        : sql`AND false`;
  return db.transaction(async (tx) => {
    const ownerlessRows = (await tx.execute(sql`
      UPDATE sim_urans_requests req
      SET state = 'cancelled', sim_job_id = NULL, "updatedAt" = now()
      WHERE req.state IN ('pending', 'running')
        ${requestScope}
        AND req.background_owner = false
        AND NOT EXISTS (
          SELECT 1
          FROM sim_urans_request_campaigns ownership
          JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
          WHERE ownership.request_id = req.id
            AND ownership.state = 'active'
            AND campaign.status IN ('active', 'attention', 'paused')
        )
        AND (
          req.state = 'pending'
          OR NOT EXISTS (
            SELECT 1 FROM sim_jobs submitted_job
            WHERE (
                submitted_job.id = req.sim_job_id
                OR submitted_job.request_payload ->> 'uransRequestId' = req.id::text
              )
              AND (
                submitted_job.engine_job_id IS NOT NULL
                OR submitted_job."submittedAt" IS NOT NULL
                OR submitted_job.status IN ('submitted', 'running', 'ingesting', 'done', 'failed')
              )
          )
        )
      RETURNING req.id
    `)) as unknown as Array<{ id: string }>;

    // Terminal jobs must settle their request even if the process died in the
    // narrow gap before consumeUransRequest/ingest bookkeeping ran. A submit
    // rejection has no accepted engine id/evidence and is cancelled; a real
    // terminal engine job (done or failed) completed the requested attempt.
    const terminalRows = (await tx.execute(sql`
      UPDATE sim_urans_requests req
      SET state = CASE
            WHEN j.status = 'failed' AND j.engine_job_id IS NULL
              AND req.fidelity = 'precalc'
              AND EXISTS (
                SELECT 1
                FROM sim_precalc_obligation_requests coverage
                JOIN sim_precalc_obligations obligation
                  ON obligation.id = coverage.obligation_id
                WHERE coverage.request_id = req.id
                  AND obligation.state IN ('pending', 'running')
              ) THEN 'pending'
            WHEN j.status = 'failed' AND j.engine_job_id IS NULL
              AND req.fidelity = 'precalc'
              AND EXISTS (
                SELECT 1 FROM sim_precalc_obligation_requests coverage
                WHERE coverage.request_id = req.id
              ) THEN 'done'
            WHEN j.status = 'failed' AND j.engine_job_id IS NULL THEN 'cancelled'
            ELSE 'done'
          END,
          sim_job_id = CASE
            WHEN j.status = 'failed' AND j.engine_job_id IS NULL
              AND req.fidelity = 'precalc'
              AND EXISTS (
                SELECT 1
                FROM sim_precalc_obligation_requests coverage
                JOIN sim_precalc_obligations obligation
                  ON obligation.id = coverage.obligation_id
                WHERE coverage.request_id = req.id
                  AND obligation.state IN ('pending', 'running')
              ) THEN NULL
            ELSE j.id
          END,
          "updatedAt" = now()
      FROM sim_jobs j
      WHERE req.state = 'running'
        ${requestScope}
        AND req.fidelity = 'precalc'
        AND (
          j.id = req.sim_job_id
          OR j.request_payload ->> 'uransRequestId' = req.id::text
        )
        AND j.status IN ('done', 'failed')
      RETURNING req.id
    `)) as unknown as { id: string }[];

    await tx.execute(sql`
      UPDATE sim_jobs j
      SET status = 'cancelled', engine_state = 'cancelled',
          error = 'orphaned URANS request composition recovered before engine submission',
          "finishedAt" = now(), "updatedAt" = now()
      FROM sim_urans_requests req
      WHERE req.state = 'running'
        ${requestScope}
        AND req."updatedAt" < now() - interval '5 minutes'
        AND j.status = 'pending'
        AND j."updatedAt" < now() - interval '5 minutes'
        AND (
          j.id = req.sim_job_id
          OR j.request_payload ->> 'uransRequestId' = req.id::text
        )
    `);
    const rows = (await tx.execute(sql`
      UPDATE sim_urans_requests req
      SET state = ${REQUEST_CLAIM_RELEASE_STATE_SQL}, sim_job_id = NULL,
          "updatedAt" = now()
      WHERE req.state = 'running'
        ${requestScope}
        AND NOT EXISTS (
          SELECT 1 FROM sim_jobs j
          WHERE (
              j.id = req.sim_job_id
              OR j.request_payload ->> 'uransRequestId' = req.id::text
            )
            AND j.status IN ('pending', 'submitted', 'running', 'ingesting', 'done', 'failed')
        )
        AND req."updatedAt" < now() - interval '5 minutes'
      RETURNING req.id
    `)) as unknown as { id: string }[];
    const fullRows = (await tx.execute(sql`
      SELECT req.id
      FROM sim_urans_requests req
      WHERE req.fidelity = 'full'
        AND req.state <> 'cancelled'
        ${requestScope}
      ORDER BY req.id
    `)) as unknown as Array<{ id: string }>;
    for (const request of fullRows) {
      await refreshFullUransRequestStateInTransaction(
        tx as unknown as DB,
        request.id,
      );
    }
    return (
      ownerlessRows.length + terminalRows.length + rows.length + fullRows.length
    );
  });
}

/** Idempotent admin request-URANS creation (contract 6): one open item per
 *  (cell, fidelity); NULL aoaDeg = whole polar. Admin creation supplies an
 *  independent owner even when it reuses a campaign-created physical row;
 *  requestedBy remains the immutable creator of that row. Returns the open/created row
 *  and whether this call created it. Continuation items (amendment C) carry
 *  continueFromResultId + budgetOverrideS and share the same idempotency: a
 *  cell with an already-open item of this fidelity returns THAT item — the
 *  admin surface shows the open item instead of stacking a duplicate. */
export class UransRequestCoverageConflict extends Error {
  readonly code = "whole_polar_overlaps_open_exact" as const;
  constructor(readonly conflictingRequestIds: string[]) {
    super(
      "a whole-polar URANS request overlaps one or more open exact-angle requests",
    );
    this.name = "UransRequestCoverageConflict";
  }
}

export class PrecalcObligationTerminalConflict extends Error {
  readonly code = "precalc_obligation_terminal" as const;
  constructor(
    readonly obligations: Array<{
      id: string;
      aoaDeg: number;
      state: "blocked" | "satisfied";
    }>,
  ) {
    super(
      "preliminary work for this immutable setup is already terminal; request a new setup revision or full-fidelity verification",
    );
    this.name = "PrecalcObligationTerminalConflict";
  }
}

export async function createUransRequest(
  db: DB,
  input: {
    airfoilId: string;
    revisionId: string;
    aoaDeg?: number | null;
    fidelity: "precalc" | "full";
    requestedBy?: string | null;
    continueFromResultId?: string | null;
    continueFromResultAttemptId?: string | null;
    budgetOverrideS?: number | null;
  },
): Promise<{ request: SimUransRequest; created: boolean }> {
  if (
    Boolean(input.continueFromResultId) !==
    Boolean(input.continueFromResultAttemptId)
  ) {
    throw new Error(
      "continuation requests require both the stable result id and exact result-attempt id",
    );
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`urans-request:${input.airfoilId}:${input.revisionId}:${input.fidelity}`}, 0)
      )
    `);
    if (input.fidelity === "precalc") {
      const terminal = await tx
        .select({
          id: simPrecalcObligations.id,
          aoaDeg: simPrecalcObligations.aoaDeg,
          state: simPrecalcObligations.state,
        })
        .from(simPrecalcObligations)
        .where(
          and(
            eq(simPrecalcObligations.airfoilId, input.airfoilId),
            eq(simPrecalcObligations.revisionId, input.revisionId),
            ...(input.aoaDeg == null
              ? []
              : [eq(simPrecalcObligations.aoaDeg, input.aoaDeg)]),
            inArray(simPrecalcObligations.state, ["blocked", "satisfied"]),
          ),
        )
        .orderBy(asc(simPrecalcObligations.aoaDeg))
        .for("update");
      if (terminal.length) {
        throw new PrecalcObligationTerminalConflict(
          terminal.map((obligation) => ({
            id: obligation.id,
            aoaDeg: obligation.aoaDeg,
            state: obligation.state as "blocked" | "satisfied",
          })),
        );
      }
    }
    let readyToInsert = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // The row lock serializes promotion with campaign cancellation. If
      // cancellation committed first, EvalPlanQual removes the now-terminal
      // row and this call inserts a fresh independent request instead.
      const open = await tx
        .select()
        .from(simUransRequests)
        .where(
          and(
            eq(simUransRequests.airfoilId, input.airfoilId),
            eq(simUransRequests.revisionId, input.revisionId),
            eq(simUransRequests.fidelity, input.fidelity),
            inArray(simUransRequests.state, ["pending", "running"]),
          ),
        )
        .orderBy(asc(simUransRequests.createdAt))
        .for("update");
      let covering: SimUransRequest | undefined;
      if (input.aoaDeg == null) {
        covering = open.find((request) => request.aoaDeg == null);
        if (!covering && open.length) {
          throw new UransRequestCoverageConflict(
            open.map((request) => request.id),
          );
        }
      } else {
        // A whole-polar request covers every exact angle. Reuse it rather than
        // stacking redundant work; otherwise only the same exact angle reuses.
        covering =
          open.find((request) => request.aoaDeg == null) ??
          open.find((request) => request.aoaDeg === input.aoaDeg);
      }
      if (!covering) {
        readyToInsert = true;
        break;
      }
      // A continuation endpoint rejects a covering request that resumes a
      // different source (or is fresh). Do not grant independent ownership
      // for a reuse the caller will reject as incompatible.
      if (
        input.continueFromResultId != null &&
        (covering.continueFromResultId !== input.continueFromResultId ||
          covering.continueFromResultAttemptId !==
            input.continueFromResultAttemptId)
      ) {
        return { request: covering, created: false };
      }
      const [promoted] = await tx
        .update(simUransRequests)
        .set({ backgroundOwner: true })
        .where(
          and(
            eq(simUransRequests.id, covering.id),
            inArray(simUransRequests.state, ["pending", "running"]),
          ),
        )
        .returning();
      if (promoted) return { request: promoted, created: false };
      // Defensive retry: the state fence should be guaranteed by the row
      // lock, but never return a terminal row as a successful admin reuse.
    }
    if (!readyToInsert) {
      throw new Error(
        "URANS request ownership promotion lost its open-row fence",
      );
    }
    const [request] = await tx
      .insert(simUransRequests)
      .values({
        airfoilId: input.airfoilId,
        revisionId: input.revisionId,
        aoaDeg: input.aoaDeg ?? null,
        fidelity: input.fidelity,
        state: "pending",
        backgroundOwner: true,
        requestedBy: input.requestedBy ?? null,
        continueFromResultId: input.continueFromResultId ?? null,
        continueFromResultAttemptId: input.continueFromResultAttemptId ?? null,
        budgetOverrideS: input.budgetOverrideS ?? null,
      })
      .returning();
    return { request, created: true };
  });
}

/** The exact immutable preliminary generation a verify job compares against.
 * The mutable results row may already select a newer preliminary or a full
 * generation, so it is only an ownership cross-check, never the source. */
export interface VerifyPrecalcSnapshot {
  resultAttemptId: string;
  cl: number | null;
  cd: number | null;
  cm: number | null;
}

export async function precalcSnapshotForVerifyItem(
  db: DB,
  item: SimUransVerifyQueueItem,
): Promise<VerifyPrecalcSnapshot | null> {
  if (!item.precalcResultAttemptId) return null;
  const [row] = await db
    .select({
      resultAttemptId: resultAttempts.id,
      resultId: resultAttempts.resultId,
      airfoilId: resultAttempts.airfoilId,
      revisionId: resultAttempts.simulationPresetRevisionId,
      aoaDeg: resultAttempts.aoaDeg,
      cl: resultAttempts.cl,
      cd: resultAttempts.cd,
      cm: resultAttempts.cm,
      status: resultAttempts.status,
      source: resultAttempts.source,
      fidelity: sql<
        string | null
      >`${resultAttempts.evidencePayload} ->> 'fidelity'`,
      classification: resultClassifications.state,
    })
    .from(resultAttempts)
    .leftJoin(
      resultClassifications,
      eq(resultClassifications.resultAttemptId, resultAttempts.id),
    )
    .where(eq(resultAttempts.id, item.precalcResultAttemptId))
    .limit(1);
  if (
    !row ||
    row.resultId !== item.precalcResultId ||
    row.airfoilId !== item.airfoilId ||
    row.revisionId !== item.revisionId ||
    Number(row.aoaDeg) !== Number(item.aoaDeg) ||
    row.status !== "done" ||
    row.source !== "solved" ||
    row.fidelity !== "urans_precalc" ||
    row.classification !== "accepted"
  )
    return null;
  return {
    resultAttemptId: row.resultAttemptId,
    cl: row.cl,
    cd: row.cd,
    cm: row.cm,
  };
}

export type FinalUransRecoveryPlan =
  | { mode: "fresh" }
  | {
      mode: "continuation";
      resultId: string;
      resultAttemptId: string;
      engineJobId: string;
      engineCaseSlug: string;
      solverImplementationId: string | null;
      budgetOverrideS: number;
    }
  | { mode: "media_repair" }
  | { mode: "exhausted"; reason: string };

/** A final verification can become terminal before a new sim_job exists:
 * either its durable retry ledger is already exhausted, or the only saved
 * continuation checkpoint is incompatible with the target implementation.
 * Fence the running claim and write the matching critical incident in the
 * same transaction so scheduler replays cannot create alert-only ghosts. */
export async function blockFinalUransVerificationBeforeSubmit(
  db: DB,
  input: {
    verifyQueueId: string;
    reason: string;
    incidentReason: string;
    targetSolverImplementationId: string;
    metadata?: Record<string, unknown>;
  },
): Promise<boolean> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const rows = (await tx.execute(sql`
      UPDATE sim_urans_verify_queue q
      SET state = 'blocked',
          sim_job_id = NULL,
          last_outcome = ${FINAL_URANS_OUTCOMES.recoveryExhausted},
          last_error = ${input.reason},
          next_submit_at = NULL,
          "updatedAt" = now()
      WHERE q.id = ${input.verifyQueueId}
        AND q.state = 'running'
        AND q.sim_job_id IS NULL
      RETURNING
        q.id,
        q.latest_result_attempt_id,
        q.fresh_attempt_count,
        q.max_fresh_attempts,
        q.continuation_attempt_count,
        q.continuation_no_progress_count
    `)) as unknown as Array<{
      id: string;
      latest_result_attempt_id: string | null;
      fresh_attempt_count: number;
      max_fresh_attempts: number;
      continuation_attempt_count: number;
      continuation_no_progress_count: number;
    }>;
    const row = rows[0];
    if (!row) return false;

    const [attempt] = row.latest_result_attempt_id
      ? await tx
          .select({
            id: resultAttempts.id,
            simJobId: resultAttempts.simJobId,
            solverImplementationId: resultAttempts.solverImplementationId,
            classificationReasons: resultClassifications.reasons,
          })
          .from(resultAttempts)
          .leftJoin(
            resultClassifications,
            eq(resultClassifications.resultAttemptId, resultAttempts.id),
          )
          .where(eq(resultAttempts.id, row.latest_result_attempt_id))
          .limit(1)
      : [];
    const solverImplementationId =
      attempt?.solverImplementationId ?? input.targetSolverImplementationId;
    await recordSolverIncidentInTransaction(tx, {
      stage: "final",
      reason: input.incidentReason,
      severity: "critical",
      owner: { verifyQueueId: row.id },
      solverImplementationId,
      occurrenceKey: `final:${row.id}:${attempt?.id ?? row.id}:${FINAL_URANS_OUTCOMES.recoveryExhausted}`,
      remediationVersion: URANS_RECOVERY_REMEDIATION_VERSION,
      simJobId: attempt?.simJobId ?? null,
      resultAttemptId: attempt?.id ?? null,
      metadata: {
        lastOutcome: FINAL_URANS_OUTCOMES.recoveryExhausted,
        schedulerReason: input.reason,
        classificationReasons: attempt?.classificationReasons ?? [],
        freshAttemptCount: row.fresh_attempt_count,
        maxFreshAttempts: row.max_fresh_attempts,
        continuationAttemptCount: row.continuation_attempt_count,
        continuationNoProgressCount: row.continuation_no_progress_count,
        targetSolverImplementationId: input.targetSolverImplementationId,
        ...input.metadata,
      },
    });
    await refreshFullUransRequestsForVerifyQueueInTransaction(tx, row.id);
    return true;
  });
}

/** Resolve the next full-fidelity action from the durable queue ledger.
 *
 * The latest immutable attempt is authoritative even when the accepted
 * preliminary result remains the selected canonical generation. Restartable
 * evidence always continues from the latest exact attempt while its physical
 * measurements advance; settlement owns the repeated-no-progress breaker. */
export async function finalUransRecoveryPlanForVerifyItem(
  db: DB,
  item: SimUransVerifyQueueItem,
): Promise<FinalUransRecoveryPlan> {
  if (item.lastOutcome === FINAL_URANS_OUTCOMES.mediaRepairPending) {
    return { mode: "media_repair" };
  }
  if (
    !item.precalcResultId ||
    !item.precalcResultAttemptId ||
    !(await hasExactValidSolverManifest(
      db,
      item.precalcResultId,
      item.precalcResultAttemptId,
    )) ||
    !(await hasExactVerifiedRestartableEvidenceArchive(
      db,
      item.precalcResultId,
      item.precalcResultAttemptId,
    ))
  ) {
    return {
      mode: "exhausted",
      reason:
        "the exact preliminary URANS restart archive is missing or unverified; FINAL cannot start from untrusted storage and will not silently fresh-solve",
    };
  }
  const continuationRequested =
    item.lastOutcome === FINAL_URANS_OUTCOMES.continuationPending ||
    item.lastOutcome === FINAL_URANS_OUTCOMES.continuationRetryWait;
  if (continuationRequested && item.latestResultAttemptId) {
    const [source] = await db
      .select({
        id: resultAttempts.id,
        resultId: resultAttempts.resultId,
        airfoilId: resultAttempts.airfoilId,
        revisionId: resultAttempts.simulationPresetRevisionId,
        aoaDeg: resultAttempts.aoaDeg,
        status: resultAttempts.status,
        source: resultAttempts.source,
        engineJobId: resultAttempts.engineJobId,
        engineCaseSlug: resultAttempts.engineCaseSlug,
        solverImplementationId: resultAttempts.solverImplementationId,
        qualityWarnings: resultAttempts.qualityWarnings,
        classification: resultClassifications.state,
        fidelity: sql<
          string | null
        >`${resultAttempts.evidencePayload} ->> 'fidelity'`,
      })
      .from(resultAttempts)
      .innerJoin(
        resultClassifications,
        eq(resultClassifications.resultAttemptId, resultAttempts.id),
      )
      .where(eq(resultAttempts.id, item.latestResultAttemptId))
      .limit(1);
    if (
      source &&
      source.airfoilId === item.airfoilId &&
      source.revisionId === item.revisionId &&
      Number(source.aoaDeg) === Number(item.aoaDeg) &&
      source.resultId != null &&
      ["done", "failed"].includes(source.status) &&
      source.source === "solved" &&
      source.fidelity === "urans_full" &&
      source.classification === "rejected" &&
      source.solverImplementationId != null &&
      hasPrecalcContinuationWarning(source.qualityWarnings) &&
      source.engineJobId &&
      source.engineCaseSlug &&
      (await hasExactValidSolverManifest(db, source.resultId, source.id)) &&
      (await hasExactVerifiedRestartableEvidenceArchive(
        db,
        source.resultId,
        source.id,
      ))
    ) {
      return {
        mode: "continuation",
        resultId: source.resultId,
        resultAttemptId: source.id,
        engineJobId: source.engineJobId,
        engineCaseSlug: source.engineCaseSlug,
        solverImplementationId: source.solverImplementationId,
        budgetOverrideS:
          item.continuationBudgetOverrideS ?? FINAL_URANS_CONTINUATION_BUDGET_S,
      };
    }
    return {
      mode: "exhausted",
      reason:
        "the exact final URANS continuation checkpoint is missing, incomplete, or unverified; automatic recovery will not discard saved-state identity with a fresh solve",
    };
  }
  if (item.freshAttemptCount < item.maxFreshAttempts) {
    return { mode: "fresh" };
  }
  return {
    mode: "exhausted",
    reason:
      "full URANS automatic recovery exhausted its fresh-start allowance after repeated non-progressing continuation",
  };
}

/** Media repair can make the exact rejected full attempt publishable without
 * another CFD solve. Complete the waiting verification from that repaired
 * immutable attempt; this is idempotent and exact-attempt fenced. */
export async function settleFinalUransVerificationAfterMediaRepair(
  db: DB,
  resultAttemptId: string,
): Promise<number> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const [attempt] = await tx
      .select({
        id: resultAttempts.id,
        resultId: resultAttempts.resultId,
        simJobId: resultAttempts.simJobId,
        cl: resultAttempts.cl,
        cd: resultAttempts.cd,
        cm: resultAttempts.cm,
        classification: resultClassifications.state,
      })
      .from(resultAttempts)
      .leftJoin(
        resultClassifications,
        eq(resultClassifications.resultAttemptId, resultAttempts.id),
      )
      .where(eq(resultAttempts.id, resultAttemptId))
      .limit(1);
    if (!attempt?.resultId || attempt.classification !== "accepted") {
      return 0;
    }
    const rows = (await tx.execute(sql`
      UPDATE sim_urans_verify_queue q
      SET state = CASE
            WHEN (
              ${attempt.cl}::double precision IS NOT NULL
              AND preliminary.cl IS NOT NULL
              AND abs(${attempt.cl}::double precision - preliminary.cl) > 0.05
            ) OR (
              ${attempt.cd}::double precision IS NOT NULL
              AND preliminary.cd IS NOT NULL
              AND abs(${attempt.cd}::double precision - preliminary.cd) > 0.01
            ) THEN 'disagreed'
            ELSE 'done'
          END,
          verify_result_id = ${attempt.resultId},
          delta_cl = CASE
            WHEN ${attempt.cl}::double precision IS NOT NULL
             AND preliminary.cl IS NOT NULL
            THEN ${attempt.cl}::double precision - preliminary.cl
            ELSE NULL
          END,
          delta_cd = CASE
            WHEN ${attempt.cd}::double precision IS NOT NULL
             AND preliminary.cd IS NOT NULL
            THEN ${attempt.cd}::double precision - preliminary.cd
            ELSE NULL
          END,
          delta_cm = CASE
            WHEN ${attempt.cm}::double precision IS NOT NULL
             AND preliminary.cm IS NOT NULL
            THEN ${attempt.cm}::double precision - preliminary.cm
            ELSE NULL
          END,
          last_outcome = CASE
            WHEN (
              ${attempt.cl}::double precision IS NOT NULL
              AND preliminary.cl IS NOT NULL
              AND abs(${attempt.cl}::double precision - preliminary.cl) > 0.05
            ) OR (
              ${attempt.cd}::double precision IS NOT NULL
              AND preliminary.cd IS NOT NULL
              AND abs(${attempt.cd}::double precision - preliminary.cd) > 0.01
            ) THEN ${FINAL_URANS_OUTCOMES.disagreed}
            ELSE ${FINAL_URANS_OUTCOMES.accepted}
          END,
          last_error = NULL,
          continuation_no_progress_count = 0,
          next_submit_at = NULL,
          "updatedAt" = now()
      FROM result_attempts preliminary
      JOIN result_classifications preliminary_classification
        ON preliminary_classification.result_attempt_id = preliminary.id
       -- Publishing the exact accepted FULL attempt refreshes classifications
       -- before this settlement runs. That refresh truthfully changes the
       -- queue-owned PRECALC generation from accepted to superseded_by_urans.
       -- Both states prove the same immutable preliminary owner; every other
       -- state remains fail-closed under the exact attempt/queue fences below.
       AND preliminary_classification.state
         IN ('accepted', 'superseded_by_urans')
      WHERE q.latest_result_attempt_id = ${attempt.id}
        AND q.precalc_result_attempt_id = preliminary.id
        AND q.precalc_result_id = preliminary.result_id
        AND preliminary.airfoil_id = q.airfoil_id
        AND preliminary.simulation_preset_revision_id = q.revision_id
        AND preliminary.aoa_deg = q.aoa_deg
        AND preliminary.status = 'done'
        AND preliminary.source = 'solved'
        AND preliminary.evidence_payload ->> 'fidelity' = 'urans_precalc'
        AND (
          (
            q.state = 'pending'
            AND q.last_outcome = ${FINAL_URANS_OUTCOMES.mediaRepairPending}
          )
          OR (
            q.state = 'blocked'
            AND q.last_outcome = ${FINAL_URANS_OUTCOMES.recoveryExhausted}
            AND EXISTS (
              SELECT 1
              FROM sim_solver_incidents incident
              WHERE incident.verify_queue_id = q.id
                AND incident.result_attempt_id = ${attempt.id}
                AND incident.occurrence_key =
                  concat_ws(
                    ':',
                    'final',
                    q.id::text,
                    ${attempt.id}::uuid::text,
                    ${FINAL_URANS_OUTCOMES.recoveryExhausted}::text
                  )
            )
          )
        )
      RETURNING q.id
    `)) as unknown as Array<{ id: string }>;
    for (const row of rows) {
      await resolveSolverIncidentsForOwnerInTransaction(tx, {
        verifyQueueId: row.id,
      });
      await refreshFullUransRequestsForVerifyQueueInTransaction(tx, row.id);
    }
    return rows.length;
  });
}
