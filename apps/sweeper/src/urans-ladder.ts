// URANS fidelity-ladder tick (pinned contracts 4–6, spec: single existing
// priority scale — no second scale). Runs inside the submit-capacity branch of
// the sweeper tick. Exact conditional whole-polar promotions take the next
// free slot; targeted terminal-parent PRECALC takes the next free slot ahead
// of unrelated new RANS. Final verification receives one bounded interleave
// after at most eight newly admitted wave-1 RANS jobs; otherwise new RANS work
// outranks admin-request PRECALC and verification. At most ONE submission wins
// each scheduler tick.
//
// Tier 2 (precalc rank):
//   a) campaign wave-2 URANS retries — a rejected RANS attempt is normal
//      escalation input and is admitted from its terminal parent without a
//      campaign-wide gap fence, ahead of ordinary RANS admission;
//   b) admin request-URANS work items (contract 6).
// Tier 3 (global lowest): verify-queue items (contract 4) — one cell re-solved
//   at FULL fidelity; deltas recorded at ingest (reconcile settle path).

import {
  airfoils,
  activeCampaignOwnersForUransRequest,
  blockFinalUransVerificationBeforeSubmit,
  claimNextPendingUransRequest,
  claimNextPendingVerifyItem,
  type DB,
  LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID,
  hasOpenCampaignLadderWork,
  healOrphanedUransRequests,
  healOrphanedVerifyItems,
  ensureFullUransRequestCoverage,
  ensurePrecalcObligations,
  finalUransRecoveryPlanForVerifyItem,
  FINAL_URANS_OUTCOMES,
  finalVerifyInterleaveDecision,
  FullUransRequestCoverageIncompleteError,
  OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
  precalcContinuationsForObligations,
  precalcRequestStateFromObligations,
  precalcSnapshotForVerifyItem,
  requeueRestartablePrecalcContinuations,
  refreshFullUransRequestState,
  releaseClaimedUransRequest,
  releaseClaimedVerifyItem,
  recordPrecalcObligationSubmission,
  recordSolverIncidentInTransaction,
  restartablePrecalcCheckpointSql,
  results,
  simCampaigns,
  simJobs,
  simLadderSubmitRetries,
  simulationPresetRevisions,
  simulationPresets,
  simUransRequests,
  simUransVerifyQueue,
  type VerifyInterleaveScope,
  URANS_RECOVERY_REMEDIATION_VERSION,
} from "@aerodb/db";
import {
  DETERMINISTIC_MESH_BLOCKER_ERROR_MARKER,
  DETERMINISTIC_MESH_BLOCKER_NONORTHO_MARKER,
} from "@aerodb/core";
import type { SimulationSetupSnapshot } from "@aerodb/db/simulation-setup";
import { snapshotAoas } from "@aerodb/db/simulation-setup";
import type { EngineClient, UransFidelity } from "@aerodb/engine-client";
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  notExists,
  notInArray,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import {
  buildPolarRequest,
  solverImplementationIdForSetup,
} from "./build-request";
import {
  engineMeshRecoveryVersion,
  engineUransRecoveryVersion,
  supportsDurableUransRecovery,
} from "./engine-capabilities";
import { recordEngineUnreachable } from "./engine-backoff";
import {
  requireExecutionPoolForSetup,
  SolverExecutionPoolUnavailableError,
} from "./engine-pool";
import { touchHeartbeat } from "./heartbeat";
import { prepareAutomaticMeshRecovery } from "./mesh-recovery";
import { composePhysicalPrecalcJob } from "./precalc-composition";
import { submitUransRetryForJob } from "./reconcile";
import {
  submitPendingJobWithLifecycleGuard,
  type SubmissionAdmissionLane,
} from "./submit-lifecycle";

/** Parents whose recovery was already re-attempted this process lifetime —
 *  a parent whose retry plan is empty must not be re-planned every tick
 *  forever. In-memory on purpose (a restart simply rescans; no payload
 *  mutation, no deadlock). Tests reset via resetUransLadderMemory(). */
const settledRecoveryParents = new Set<string>();

export function resetUransLadderMemory(): void {
  settledRecoveryParents.clear();
}

function normalizedContinuationImplementationId(
  implementationId: string | null | undefined,
): string | null {
  if (!implementationId) return null;
  return implementationId === LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID
    ? OPENCFD_2406_SOLVER_IMPLEMENTATION_ID
    : implementationId;
}

const RECOVERY_PARENTS_PER_TICK = 3;
const PROMOTION_RECOVERIES_PER_TICK = 16;

interface CampaignPrecalcRecoveryParent {
  /** Immutable physical job which produced the pinned RANS attempt. */
  sourceParent: typeof simJobs.$inferSelect;
  /** Active beneficiary which authorizes scheduling and lifecycle checks.
   * This may intentionally differ from sourceParent.campaignId. */
  ownerCampaignId: string;
  /** Exact attempts that authorize this campaign-owned targeted handoff. */
  sourceResultAttemptIds?: string[];
}

/** Durable PRECALC obligations are the scheduling authority. Discover their
 * exact source parents before the legacy finished-parent scan so a newly
 * terminal escalation cannot sit behind an arbitrary history window (or be
 * pushed back to that window after a process restart). The source-attempt FK
 * remains pinned to the original RANS evidence while latest_sim_job_id tracks
 * any later PRECALC continuation, so this path needs no JSON rediscovery.
 *
 * The query is intentionally bounded to the same per-pass parent budget as the
 * legacy scan. Whole-polar obligations are owned by the earlier recorded-
 * promotion branch and are excluded here.
 */
async function dueCampaignPrecalcRecoveryParents(
  db: DB,
  campaignId: string,
  parentJobIds: string[] | undefined,
  uransRecoveryVersion: number | null | undefined,
): Promise<CampaignPrecalcRecoveryParent[]> {
  const parentScope =
    parentJobIds === undefined
      ? sql``
      : parentJobIds.length
        ? sql`AND parent.id = ANY(${sql`ARRAY[${sql.join(
            parentJobIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]`})`
        : sql`AND false`;
  const restartableScope = supportsDurableUransRecovery(uransRecoveryVersion)
    ? restartablePrecalcCheckpointSql(sql`obligation.id`)
    : sql`false`;
  const rows = (await db.execute(sql`
    SELECT parent.id,
           array_agg(DISTINCT source_attempt.id ORDER BY source_attempt.id)
             AS source_attempt_ids,
           min(COALESCE(obligation.next_submit_at, obligation."createdAt")) AS due_at
    FROM sim_precalc_obligations obligation
    JOIN sim_precalc_obligation_campaigns ownership
      ON ownership.obligation_id = obligation.id
     AND ownership.state = 'active'
    JOIN sim_campaigns owner_campaign
      ON owner_campaign.id = ownership.campaign_id
     AND owner_campaign.status IN ('active', 'attention')
    JOIN result_attempts source_attempt
      ON source_attempt.id = obligation.source_result_attempt_id
     AND source_attempt.regime = 'rans'
     AND source_attempt.airfoil_id = obligation.airfoil_id
     AND source_attempt.simulation_preset_revision_id = obligation.revision_id
     AND source_attempt.aoa_deg = obligation.aoa_deg
    JOIN sim_jobs parent
      ON parent.id = source_attempt.sim_job_id
     AND parent.airfoil_id = obligation.airfoil_id
     AND parent.wave = 1
    WHERE ownership.campaign_id = ${campaignId}
      AND obligation.state = 'pending'
      AND (
        obligation.next_submit_at IS NULL
        OR obligation.next_submit_at <= now()
      )
      AND (
        obligation.attempt_count < obligation.max_attempts
        OR (${restartableScope})
      )
      AND (
        (
          parent.status IN ('done', 'failed')
          AND parent."ingestedAt" IS NOT NULL
        )
        OR parent.status = 'cancelled'
      )
      ${parentScope}
      AND NOT EXISTS (
        SELECT 1
        FROM sim_jobs live_child
        WHERE live_child.parent_job_id = parent.id
          AND live_child.wave = 2
          AND live_child.status IN ('pending', 'submitted', 'running', 'ingesting')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM sim_jobs latest_job
        WHERE latest_job.id = obligation.latest_sim_job_id
          AND latest_job.status IN ('pending', 'submitted', 'running', 'ingesting')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM sim_rans_polar_promotion_points promotion_point
        WHERE promotion_point.obligation_id = obligation.id
      )
    GROUP BY parent.id
    ORDER BY due_at, parent.id
    LIMIT ${RECOVERY_PARENTS_PER_TICK}
  `)) as unknown as Array<{
    id: string;
    source_attempt_ids: string[];
    due_at: Date | string;
  }>;
  if (!rows.length) return [];
  const parents = await db
    .select()
    .from(simJobs)
    .where(
      inArray(
        simJobs.id,
        rows.map((row) => row.id),
      ),
    );
  const byId = new Map(parents.map((parent) => [parent.id, parent]));
  return rows.flatMap((row) => {
    const parent = byId.get(row.id);
    return parent
      ? [
          {
            sourceParent: parent,
            ownerCampaignId: campaignId,
            sourceResultAttemptIds: row.source_attempt_ids,
          },
        ]
      : [];
  });
}

/** Compatibility for pre-pinning obligations. Drive from the campaign-owner
 * index into its few open physical cells, then resolve the latest exact source
 * attempt and parent. Never add an OR branch to the broad sim_jobs history
 * scan: production has a large global job ledger and this path runs per tick. */
async function legacySharedCampaignRecoveryParents(
  db: DB,
  campaignId: string,
  parentJobIds: string[] | undefined,
  excludedParentIds: string[],
  limit: number,
  uransRecoveryVersion: number | null | undefined,
): Promise<CampaignPrecalcRecoveryParent[]> {
  if (limit <= 0) return [];
  const parentScope =
    parentJobIds === undefined
      ? sql``
      : parentJobIds.length
        ? sql`AND parent.id = ANY(${sql`ARRAY[${sql.join(
            parentJobIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]`})`
        : sql`AND false`;
  const excludedScope = excludedParentIds.length
    ? sql`AND parent.id <> ALL(${sql`ARRAY[${sql.join(
        excludedParentIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]`})`
    : sql``;
  const restartableScope = supportsDurableUransRecovery(uransRecoveryVersion)
    ? restartablePrecalcCheckpointSql(sql`owned_obligation.id`)
    : sql`false`;
  const rows = (await db.execute(sql`
    SELECT parent.id AS parent_id,
           array_agg(DISTINCT owned_attempt.id ORDER BY owned_attempt.id)
             AS source_attempt_ids
    FROM sim_precalc_obligations owned_obligation
    JOIN sim_precalc_obligation_campaigns owned_route
     ON owned_route.obligation_id = owned_obligation.id
     AND owned_route.campaign_id = ${campaignId}
     AND owned_route.state = 'active'
    JOIN result_attempts owned_attempt
      ON owned_attempt.regime = 'rans'
     AND owned_attempt.airfoil_id = owned_obligation.airfoil_id
     AND owned_attempt.simulation_preset_revision_id = owned_obligation.revision_id
     AND owned_attempt.aoa_deg = owned_obligation.aoa_deg
    JOIN sim_jobs parent
      ON parent.id = owned_attempt.sim_job_id
     AND parent.airfoil_id = owned_obligation.airfoil_id
     AND parent.wave = 1
     AND parent.campaign_id IS DISTINCT FROM ${campaignId}
    WHERE owned_obligation.source_result_attempt_id IS NULL
      AND owned_obligation.state = 'pending'
      AND (
        owned_obligation.next_submit_at IS NULL
        OR owned_obligation.next_submit_at <= now()
      )
      AND (
        owned_obligation.attempt_count < owned_obligation.max_attempts
        OR (${restartableScope})
      )
      AND (
        (
          parent.status IN ('done', 'failed')
          AND parent."ingestedAt" IS NOT NULL
        )
        OR parent.status = 'cancelled'
      )
      ${parentScope}
      ${excludedScope}
      AND NOT EXISTS (
        SELECT 1
        FROM result_attempts newer_attempt
        WHERE newer_attempt.sim_job_id = owned_attempt.sim_job_id
          AND newer_attempt.regime = 'rans'
          AND newer_attempt.airfoil_id = owned_attempt.airfoil_id
          AND newer_attempt.simulation_preset_revision_id = owned_attempt.simulation_preset_revision_id
          AND newer_attempt.aoa_deg = owned_attempt.aoa_deg
          AND (
            newer_attempt."createdAt" > owned_attempt."createdAt"
            OR (
              newer_attempt."createdAt" = owned_attempt."createdAt"
              AND newer_attempt.id > owned_attempt.id
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM sim_jobs live_child
        WHERE live_child.parent_job_id = parent.id
          AND live_child.wave = 2
          AND live_child.status IN ('pending', 'submitted', 'running', 'ingesting')
      )
    GROUP BY parent.id
    ORDER BY min(COALESCE(owned_obligation.next_submit_at, owned_obligation."createdAt")), parent.id
    LIMIT ${limit}
  `)) as unknown as Array<{
    parent_id: string;
    source_attempt_ids: string[];
  }>;
  if (!rows.length) return [];
  const parents = await db
    .select()
    .from(simJobs)
    .where(
      inArray(
        simJobs.id,
        rows.map((row) => row.parent_id),
      ),
    );
  const parentById = new Map(parents.map((parent) => [parent.id, parent]));
  return rows.flatMap((row) => {
    const sourceParent = parentById.get(row.parent_id);
    return sourceParent
      ? [
          {
            sourceParent,
            ownerCampaignId: campaignId,
            sourceResultAttemptIds: row.source_attempt_ids,
          },
        ]
      : [];
  });
}

function jobMeshRecoveryVersionSql(requestPayload: SQLWrapper) {
  return sql`CASE
    WHEN jsonb_typeof(${requestPayload} -> 'executedMeshRecoveryVersion') = 'number'
     AND ${requestPayload} ->> 'executedMeshRecoveryVersion' ~ '^[0-9]+$'
    THEN CASE
      WHEN (${requestPayload} ->> 'executedMeshRecoveryVersion')::numeric <= 2147483647
      THEN (${requestPayload} ->> 'executedMeshRecoveryVersion')::numeric::bigint
      ELSE 0::bigint
    END
    ELSE 0::bigint
  END`;
}

/** Effective execution provenance for a terminal PRECALC obligation. The
 * immutable submission audit is authoritative and survives sim_job retention;
 * worker-acknowledged job JSON is only a compatibility fallback for historical
 * rows without that ledger. Requested meshRecoveryVersion is never evidence. */
function obligationMeshRecoveryVersionSql(
  obligationId: SQLWrapper,
  latestSimJobId: SQLWrapper,
) {
  return sql`COALESCE(
    (
      SELECT immutable_attempt.mesh_recovery_version::bigint
      FROM sim_precalc_obligation_attempts immutable_attempt
      WHERE immutable_attempt.obligation_id = ${obligationId}
      ORDER BY immutable_attempt.attempt_number DESC
      LIMIT 1
    ),
    (
      SELECT ${jobMeshRecoveryVersionSql(sql`producing_job.request_payload`)}
      FROM sim_jobs producing_job
      WHERE producing_job.id = ${latestSimJobId}
    ),
    0::bigint
  )`;
}

function deterministicMeshEvidenceSql(
  failureDisposition: SQLWrapper,
  error: SQLWrapper,
) {
  return sql`(
    ${failureDisposition} = 'deterministic_mesh'
    OR (
      ${failureDisposition} IS NULL
      AND
      position(${DETERMINISTIC_MESH_BLOCKER_ERROR_MARKER} in lower(COALESCE(${error}, ''))) > 0
      AND position(${DETERMINISTIC_MESH_BLOCKER_NONORTHO_MARKER} in lower(COALESCE(${error}, ''))) > 0
    )
  )`;
}

const RESERVED_LADDER_PAYLOAD_KEYS = new Set([
  "aoas",
  "meshRecoveryVersion",
  "resources",
  "setupSnapshot",
  "speedMap",
  "uransRecoveryVersion",
  "uransFidelity",
]);

export function assertNoReservedLadderPayloadKeys(
  payloadExtras: Record<string, unknown>,
): void {
  const conflicting = Object.keys(payloadExtras).filter((key) =>
    RESERVED_LADDER_PAYLOAD_KEYS.has(key),
  );
  if (conflicting.length) {
    throw new Error(
      `ladder payload extras cannot override reserved execution provenance: ${conflicting.sort().join(", ")}`,
    );
  }
}

function promotionRecoveryScopeSql(opts: {
  campaignIds?: string[];
  parentJobIds?: string[];
  promotionIds?: string[];
}) {
  // An exact promotion scope is the strongest test/recovery fence. Otherwise
  // reuse the existing parent/campaign closed-world scopes. Production passes
  // none and therefore scans the complete durable promotion ledger.
  if (opts.promotionIds !== undefined) {
    return opts.promotionIds.length
      ? sql`promotion.id = ANY(${sql`ARRAY[${sql.join(
          opts.promotionIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]`})`
      : sql`false`;
  }
  if (opts.parentJobIds !== undefined) {
    return opts.parentJobIds.length
      ? sql`parent.id = ANY(${sql`ARRAY[${sql.join(
          opts.parentJobIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]`})`
      : sql`false`;
  }
  if (opts.campaignIds !== undefined) {
    return opts.campaignIds.length
      ? sql`promotion.campaign_id = ANY(${sql`ARRAY[${sql.join(
          opts.campaignIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]`})`
      : sql`false`;
  }
  return sql`true`;
}

interface RecordedPromotionPoint {
  promotionId: string;
  parentJobId: string;
  airfoilId: string;
  revisionId: string;
  conditionId: string | null;
  ownerKind: "campaign" | "background" | "sync_promise";
  ownerCampaignId: string | null;
  syncPromiseId: string | null;
  aoaDeg: number;
  obligationId: string;
  state: string;
  attemptCount: number;
  maxAttempts: number;
  nextSubmitAt: Date | string | null;
}

async function recordedPromotionPoints(
  db: DB,
  promotionId: string,
  parentJobId: string,
): Promise<RecordedPromotionPoint[]> {
  const rows = (await db.execute(sql`
    SELECT promotion.id AS promotion_id,
           promotion.parent_job_id,
           promotion.airfoil_id,
           promotion.revision_id,
           promotion.condition_id,
           promotion.owner_kind,
           promotion.campaign_id AS owner_campaign_id,
           promotion.sync_promise_id,
           point.aoa_deg::float8 AS aoa_deg,
           point.obligation_id,
           obligation.state,
           obligation.attempt_count,
           obligation.max_attempts,
           obligation.next_submit_at
    FROM sim_rans_polar_promotions promotion
    JOIN sim_jobs parent ON parent.id = promotion.parent_job_id
    JOIN sim_rans_polar_promotion_points point
      ON point.promotion_id = promotion.id
    JOIN sim_precalc_obligations obligation
      ON obligation.id = point.obligation_id
     AND obligation.airfoil_id = promotion.airfoil_id
     AND obligation.revision_id = promotion.revision_id
     AND obligation.aoa_deg = point.aoa_deg
    WHERE promotion.id = ${promotionId}
      AND promotion.parent_job_id = ${parentJobId}
    ORDER BY point.aoa_deg, point.obligation_id
  `)) as unknown as Array<{
    promotion_id: string;
    parent_job_id: string;
    airfoil_id: string;
    revision_id: string;
    condition_id: string | null;
    owner_kind: "campaign" | "background" | "sync_promise";
    owner_campaign_id: string | null;
    sync_promise_id: string | null;
    aoa_deg: number;
    obligation_id: string;
    state: string;
    attempt_count: number;
    max_attempts: number;
    next_submit_at: Date | string | null;
  }>;
  return rows.map((row) => ({
    promotionId: row.promotion_id,
    parentJobId: row.parent_job_id,
    airfoilId: row.airfoil_id,
    revisionId: row.revision_id,
    conditionId: row.condition_id,
    ownerKind: row.owner_kind,
    ownerCampaignId: row.owner_campaign_id,
    syncPromiseId: row.sync_promise_id,
    aoaDeg: Number(row.aoa_deg),
    obligationId: row.obligation_id,
    state: row.state,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    nextSubmitAt: row.next_submit_at,
  }));
}

async function recordedPromotionHasDeterministicMeshBlocker(
  db: DB,
  event: Pick<
    RecordedPromotionPoint,
    "promotionId" | "parentJobId" | "revisionId" | "conditionId"
  >,
  meshRecoveryVersion: number,
): Promise<boolean> {
  const conditionSql = event.conditionId
    ? sql`child.request_payload ->> 'conditionId' = ${event.conditionId}`
    : sql`child.request_payload ->> 'conditionId' IS NULL`;
  const rows = (await db.execute(sql`
    SELECT 1
    WHERE EXISTS (
      SELECT 1
      FROM sim_rans_polar_promotion_points point
      JOIN sim_precalc_obligations obligation
        ON obligation.id = point.obligation_id
      WHERE point.promotion_id = ${event.promotionId}
        AND obligation.last_outcome = 'deterministic_failure'
        AND ${obligationMeshRecoveryVersionSql(
          sql`obligation.id`,
          sql`obligation.latest_sim_job_id`,
        )} >= ${meshRecoveryVersion}
    ) OR EXISTS (
      SELECT 1
      FROM sim_jobs child
      CROSS JOIN LATERAL (
        SELECT attempt.error,
               attempt.evidence_payload ->> 'failure_disposition' AS failure_disposition
        FROM result_attempts attempt
        WHERE attempt.sim_job_id = child.id
        UNION ALL
        SELECT canonical.error,
               current_attempt.evidence_payload ->> 'failure_disposition' AS failure_disposition
        FROM results canonical
        LEFT JOIN result_attempts current_attempt
          ON current_attempt.id = canonical.current_result_attempt_id
         AND current_attempt.result_id = canonical.id
        WHERE canonical.sim_job_id = child.id
      ) evidence
      WHERE child.parent_job_id = ${event.parentJobId}
        AND child.wave = 2
        AND child.simulation_preset_revision_id = ${event.revisionId}
        AND (${conditionSql})
        AND child.request_payload ->> 'uransFidelity' = 'precalc'
        AND ${jobMeshRecoveryVersionSql(sql`child.request_payload`)} >= ${meshRecoveryVersion}
        AND ${deterministicMeshEvidenceSql(
          sql`evidence.failure_disposition`,
          sql`evidence.error`,
        )}
    )
    LIMIT 1
  `)) as unknown as unknown[];
  if (!rows.length) return false;
  console.error(
    `[sweeper] recorded whole-polar promotion ${event.promotionId} remains blocked by deterministic shared-mesh evidence at mesh recovery strategy v${meshRecoveryVersion}; exact obligation coverage is retained and unchanged mesh is not resubmitted`,
  );
  return true;
}

type PromotionRemoteProvenance =
  | { required: false }
  | {
      required: true;
      syncPromiseId: string;
      remoteSolver: true;
      upstreamBaseUrl: string;
    }
  | { required: true; unavailable: true };

/** Resolve execution ownership from the exact physical obligations, never
 * from mutable parent request JSON. A remote recovery must use one still-live
 * promise covering every selected obligation because the guarded submit
 * boundary validates the same complete payload scope. */
async function remoteProvenanceForPromotionObligations(
  db: DB,
  obligationIds: string[],
  event: Pick<RecordedPromotionPoint, "ownerKind" | "syncPromiseId">,
): Promise<PromotionRemoteProvenance> {
  const idArray = sql`ARRAY[${sql.join(
    obligationIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]`;
  // Owner kind and remote promise id are immutable event provenance. Never
  // infer either from mutable shared-obligation owners: a later campaign or a
  // replacement promise may benefit from the same physical solve, but cannot
  // adopt this event's submit authority.
  if (event.ownerKind !== "sync_promise") return { required: false };
  if (!event.syncPromiseId) return { required: true, unavailable: true };
  const [promise] = (await db.execute(sql`
    SELECT remote_promise.id, remote_promise.source_base_url
    FROM sync_sweep_promises remote_promise
    WHERE remote_promise.id = ${event.syncPromiseId}
      AND remote_promise.status = 'active'
      AND remote_promise."expiresAt" > now()
      AND remote_promise.request_payload ->> 'remoteSolver' = 'true'
      AND remote_promise.source_base_url IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM sim_precalc_obligations obligation
        WHERE obligation.id = ANY(${idArray})
          AND NOT EXISTS (
            SELECT 1
            FROM sync_sweep_promise_points promise_point
            WHERE promise_point.promise_id = remote_promise.id
              AND promise_point.status = 'active'
              AND promise_point.airfoil_id = obligation.airfoil_id
              AND promise_point.simulation_preset_revision_id = obligation.revision_id
              AND promise_point.aoa_deg = obligation.aoa_deg
          )
      )
    LIMIT 1
  `)) as unknown as Array<{ id: string; source_base_url: string }>;
  if (!promise) return { required: true, unavailable: true };
  return {
    required: true,
    syncPromiseId: promise.id,
    remoteSolver: true,
    upstreamBaseUrl: promise.source_base_url,
  };
}

/** Recover a normalized conditional-promotion event whose transaction
 * committed before its wave-2 child was composed. The immutable event points
 * and their exact physical-obligation ids are the sole scope authority; this
 * path does not re-read mutable parent transport JSON or re-run classification.
 *
 * A still-live ingest lease is deliberately excluded: the ingest owner that
 * recorded the event gets the first chance to compose. A crashed owner becomes
 * eligible after lease expiry, while a terminal parent is immediately safe to
 * recover. A recorded conditional whole-polar promotion bypasses the normal
 * campaign-wide RANS gate: its exact parent, condition, and original angle
 * list are already immutable in the promotion ledger, so unrelated campaign
 * cells must not delay its preliminary replacement. */
/** Submit one exact, durable conditional whole-polar promotion. This is the
 * sole ladder path allowed ahead of ordinary RANS: the owner already approved
 * the promoted replacement, and its scope is immutable in the ledger. */
export async function submitRecordedPromotionRecovery(
  db: DB,
  engine: EngineClient,
  cpuSlots: number,
  opts: {
    campaignIds?: string[];
    parentJobIds?: string[];
    promotionIds?: string[];
    meshRecoveryVersion?: number;
    uransRecoveryVersion?: number | null;
  } = {},
): Promise<boolean> {
  const meshRecoveryVersion =
    opts.meshRecoveryVersion ?? (await engineMeshRecoveryVersion(engine));
  if (meshRecoveryVersion == null) {
    console.error(
      "[sweeper] conditional promotion recovery deferred: engine mesh-recovery capability is unavailable or malformed",
    );
    return false;
  }
  const uransRecoveryVersion =
    opts.uransRecoveryVersion !== undefined
      ? opts.uransRecoveryVersion
      : await engineUransRecoveryVersion(engine);
  const durableRecoveryAvailable =
    supportsDurableUransRecovery(uransRecoveryVersion);
  const scope = promotionRecoveryScopeSql(opts);
  const candidates = (await db.execute(sql`
    SELECT promotion.id AS promotion_id, parent.id AS parent_job_id
    FROM sim_rans_polar_promotions promotion
    JOIN sim_jobs parent ON parent.id = promotion.parent_job_id
    WHERE (${scope})
      AND (
        parent.status IN ('done', 'failed', 'cancelled')
        OR (
          parent.status = 'ingesting'
          AND (
            parent.ingest_lease_expires_at IS NULL
            OR parent.ingest_lease_expires_at <= now()
          )
        )
      )
      AND NOT (
        parent.status = 'cancelled'
        AND promotion.owner_kind = 'background'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM sim_rans_polar_promotion_points blocked_point
        JOIN sim_precalc_obligations blocked_obligation
          ON blocked_obligation.id = blocked_point.obligation_id
        WHERE blocked_point.promotion_id = promotion.id
          AND blocked_obligation.last_outcome = 'deterministic_failure'
          AND ${obligationMeshRecoveryVersionSql(
            sql`blocked_obligation.id`,
            sql`blocked_obligation.latest_sim_job_id`,
          )} >= ${meshRecoveryVersion}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM sim_jobs blocked_child
        CROSS JOIN LATERAL (
          SELECT attempt.error,
                 attempt.evidence_payload ->> 'failure_disposition' AS failure_disposition
          FROM result_attempts attempt
          WHERE attempt.sim_job_id = blocked_child.id
          UNION ALL
          SELECT canonical.error,
                 current_attempt.evidence_payload ->> 'failure_disposition' AS failure_disposition
          FROM results canonical
          LEFT JOIN result_attempts current_attempt
            ON current_attempt.id = canonical.current_result_attempt_id
           AND current_attempt.result_id = canonical.id
          WHERE canonical.sim_job_id = blocked_child.id
        ) blocked_evidence
        WHERE blocked_child.parent_job_id = parent.id
          AND blocked_child.wave = 2
          AND blocked_child.simulation_preset_revision_id = promotion.revision_id
          AND (
            (promotion.condition_id IS NULL AND blocked_child.request_payload ->> 'conditionId' IS NULL)
            OR blocked_child.request_payload ->> 'conditionId' = promotion.condition_id::text
          )
          AND blocked_child.request_payload ->> 'uransFidelity' = 'precalc'
          AND ${jobMeshRecoveryVersionSql(sql`blocked_child.request_payload`)} >= ${meshRecoveryVersion}
          AND ${deterministicMeshEvidenceSql(
            sql`blocked_evidence.failure_disposition`,
            sql`blocked_evidence.error`,
          )}
      )
      AND EXISTS (
        SELECT 1
        FROM sim_rans_polar_promotion_points point
        JOIN sim_precalc_obligations obligation
          ON obligation.id = point.obligation_id
        WHERE point.promotion_id = promotion.id
          AND obligation.state = 'pending'
          AND (
            obligation.attempt_count < obligation.max_attempts
            OR ${restartablePrecalcCheckpointSql(sql`obligation.id`)}
          )
          AND (
            obligation.next_submit_at IS NULL
            OR obligation.next_submit_at <= now()
          )
          AND (
            (
              promotion.owner_kind = 'background'
              AND obligation.background_owner
            )
            OR (
              promotion.owner_kind = 'campaign'
              AND EXISTS (
              SELECT 1
              FROM sim_precalc_obligation_campaigns ownership
              JOIN sim_campaigns owner_campaign
                ON owner_campaign.id = ownership.campaign_id
               AND owner_campaign.status IN ('active', 'attention')
              WHERE ownership.obligation_id = obligation.id
                AND ownership.state = 'active'
                AND ownership.campaign_id = promotion.campaign_id
              )
            )
            OR (
              promotion.owner_kind = 'sync_promise'
              AND EXISTS (
              SELECT 1
              FROM sync_sweep_promise_points promise_point
              JOIN sync_sweep_promises promise
                ON promise.id = promise_point.promise_id
               AND promise.status = 'active'
               AND promise."expiresAt" > now()
               AND promise.request_payload ->> 'remoteSolver' = 'true'
              WHERE promise_point.airfoil_id = obligation.airfoil_id
                AND promise_point.simulation_preset_revision_id = obligation.revision_id
                AND promise_point.aoa_deg = obligation.aoa_deg
                AND promise_point.status = 'active'
                AND promise.id = promotion.sync_promise_id
              )
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM sim_rans_polar_promotion_points unowned_point
        JOIN sim_precalc_obligations unowned_obligation
          ON unowned_obligation.id = unowned_point.obligation_id
        WHERE unowned_point.promotion_id = promotion.id
          AND unowned_obligation.state = 'pending'
          AND (
            unowned_obligation.attempt_count < unowned_obligation.max_attempts
            OR ${restartablePrecalcCheckpointSql(sql`unowned_obligation.id`)}
          )
          AND (
            unowned_obligation.next_submit_at IS NULL
            OR unowned_obligation.next_submit_at <= now()
          )
          AND NOT (
            (
              promotion.owner_kind = 'background'
              AND unowned_obligation.background_owner
            )
            OR (
              promotion.owner_kind = 'campaign'
              AND EXISTS (
              SELECT 1
              FROM sim_precalc_obligation_campaigns ownership
              JOIN sim_campaigns owner_campaign
                ON owner_campaign.id = ownership.campaign_id
               AND owner_campaign.status IN ('active', 'attention')
              WHERE ownership.obligation_id = unowned_obligation.id
                AND ownership.state = 'active'
                AND ownership.campaign_id = promotion.campaign_id
              )
            )
            OR (
              promotion.owner_kind = 'sync_promise'
              AND EXISTS (
              SELECT 1
              FROM sync_sweep_promise_points promise_point
              JOIN sync_sweep_promises promise
                ON promise.id = promise_point.promise_id
               AND promise.status = 'active'
               AND promise."expiresAt" > now()
               AND promise.request_payload ->> 'remoteSolver' = 'true'
              WHERE promise_point.airfoil_id = unowned_obligation.airfoil_id
                AND promise_point.simulation_preset_revision_id = unowned_obligation.revision_id
                AND promise_point.aoa_deg = unowned_obligation.aoa_deg
                AND promise_point.status = 'active'
                AND promise.id = promotion.sync_promise_id
              )
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM sim_jobs live_child
        WHERE live_child.parent_job_id = parent.id
          AND live_child.wave = 2
          AND live_child.status IN ('pending', 'submitted', 'running', 'ingesting')
      )
    ORDER BY promotion."createdAt", promotion.id
    LIMIT ${PROMOTION_RECOVERIES_PER_TICK}
  `)) as unknown as Array<{
    promotion_id: string;
    parent_job_id: string;
  }>;

  for (const candidate of candidates) {
    await touchHeartbeat(db);
    const points = await recordedPromotionPoints(
      db,
      candidate.promotion_id,
      candidate.parent_job_id,
    );
    const event = points[0];
    if (!event || points.length <= 1) continue;
    if (
      await recordedPromotionHasDeterministicMeshBlocker(
        db,
        {
          promotionId: event.promotionId,
          parentJobId: event.parentJobId,
          revisionId: event.revisionId,
          conditionId: event.conditionId,
        },
        meshRecoveryVersion,
      )
    )
      continue;
    const now = Date.now();
    const duePending = points.filter(
      (point) =>
        point.state === "pending" &&
        (!point.nextSubmitAt || new Date(point.nextSubmitAt).getTime() <= now),
    );
    const continuations = await precalcContinuationsForObligations(
      db,
      duePending.map((point) => point.obligationId),
    );
    const continuationIds = new Set(
      continuations.map((continuation) => continuation.obligationId),
    );
    let schedulable = duePending.filter((point) =>
      continuationIds.has(point.obligationId)
        ? durableRecoveryAvailable
        : point.attemptCount < point.maxAttempts,
    );
    if (!schedulable.length) continue;
    let obligationIds = schedulable.map((point) => point.obligationId);
    const continuation = durableRecoveryAvailable
      ? continuations.find((candidate) =>
          obligationIds.includes(candidate.obligationId),
        )
      : undefined;
    let continueFrom: { engineJobId: string; caseSlug: string } | null = null;
    let budgetOverrideS: number | null = null;
    let continuationResultAttemptId: string | null = null;
    if (continuation) {
      schedulable = schedulable.filter(
        (point) => point.obligationId === continuation.obligationId,
      );
      obligationIds = [continuation.obligationId];
      continueFrom = {
        engineJobId: continuation.engineJobId,
        caseSlug: continuation.engineCaseSlug,
      };
      budgetOverrideS = continuation.budgetOverrideS;
      continuationResultAttemptId = continuation.resultAttemptId;
    }
    const remote = await remoteProvenanceForPromotionObligations(
      db,
      obligationIds,
      event,
    );
    if (remote.required && "unavailable" in remote) continue;
    const target = await resolveTarget(db, event.airfoilId, event.revisionId);
    if (!target) continue;
    const aoas = schedulable.map((point) => point.aoaDeg);
    const outcome = await submitLadderJob(db, engine, {
      target,
      aoas,
      fidelity: "precalc",
      jobKind: "targeted",
      campaignId: null,
      payloadExtras: {
        ...(remote.required
          ? {
              syncPromiseId: remote.syncPromiseId,
              remoteSolver: remote.remoteSolver,
              upstreamBaseUrl: remote.upstreamBaseUrl,
            }
          : {}),
        conditionalPromotionId: event.promotionId,
        parentJobId: event.parentJobId,
        conditionId: event.conditionId,
        precalcObligationIds: obligationIds,
        retryMode: "whole-polar-urans",
        promotionRequestedAoas: points.map((point) => point.aoaDeg),
        ...(continuationResultAttemptId
          ? {
              continueFromResultAttemptId: continuationResultAttemptId,
              budgetOverrideS,
            }
          : {}),
      },
      cpuSlots,
      continueFrom,
      budgetOverrideS,
      meshRecoveryVersion,
      uransRecoveryVersion: continuation ? uransRecoveryVersion! : undefined,
      recordedPromotion: {
        promotionId: event.promotionId,
        parentJobId: event.parentJobId,
        conditionId: event.conditionId,
        obligationIds,
      },
    });
    if (outcome.submitted) {
      await recordPrecalcObligationSubmission(db, outcome.jobId, obligationIds);
      console.log(
        `[sweeper] recovered conditional whole-polar promotion ${event.promotionId} directly from its durable ledger through wave-2 child ${outcome.jobId} (parent ${event.parentJobId}, angles [${aoas.join(", ")}])`,
      );
      return true;
    }
    if (outcome.submissionInProgress) return true;
  }
  return false;
}

/** Tier-2a: submit one durable campaign PRECALC recovery. The source wave-1
 * parent must be terminal, so URANS never races it over shared mesh state.
 * Every due durable targeted handoff stays ahead of unrelated ordinary RANS;
 * one scheduler pass still admits at most one physical child. */
export async function submitCampaignPrecalcRecoveries(
  db: DB,
  engine: EngineClient,
  campaignIds?: string[],
  parentJobIds?: string[],
  meshRecoveryVersion?: number,
  uransRecoveryVersion?: number | null,
): Promise<boolean> {
  // An explicitly supplied empty list is a closed-world scope, not the
  // production-wide default. One-shot operators use this fence to prove that
  // they cannot admit ordinary campaign recovery while targeting a single
  // request/verify chain. Do this before any query or process-local recovery
  // mutation so an empty canary scope is observably inert.
  if (
    (campaignIds !== undefined && campaignIds.length === 0) ||
    (parentJobIds !== undefined && parentJobIds.length === 0)
  ) {
    return false;
  }
  const statusFilter = inArray(simCampaigns.status, ["active", "attention"]);
  const campaigns = await db
    .select({ id: simCampaigns.id })
    .from(simCampaigns)
    .where(
      campaignIds !== undefined
        ? and(statusFilter, inArray(simCampaigns.id, campaignIds))
        : statusFilter,
    )
    .orderBy(simCampaigns.id);
  for (const campaign of campaigns) {
    let attempted = 0;
    const attemptedParentIds = new Set<string>();
    const attemptParents = async (
      parents: CampaignPrecalcRecoveryParent[],
      durablePriority: boolean,
    ): Promise<boolean> => {
      for (const candidate of parents) {
        const parent = candidate.sourceParent;
        if (!durablePriority && settledRecoveryParents.has(parent.id)) continue;
        if (attempted >= RECOVERY_PARENTS_PER_TICK) break;
        attempted += 1;
        attemptedParentIds.add(parent.id);
        // A durable obligation may have appeared after this parent was memoized
        // as legacy no-plan. The ledger is authoritative over process memory.
        if (durablePriority) settledRecoveryParents.delete(parent.id);
        await touchHeartbeat(db);
        const before = await db
          .select({ id: simJobs.id })
          .from(simJobs)
          .where(and(eq(simJobs.parentJobId, parent.id), eq(simJobs.wave, 2)));
        // The source job is physical provenance, not execution ownership. A
        // campaign may legitimately benefit from a RANS attempt produced by
        // background work (or another campaign), so carry the active owner
        // into gating/route creation while retaining the exact source id.
        const ownerScopedParent =
          parent.campaignId === candidate.ownerCampaignId
            ? parent
            : { ...parent, campaignId: candidate.ownerCampaignId };
        await submitUransRetryForJob(db, engine, ownerScopedParent, {
          meshRecoveryVersion,
          uransRecoveryVersion,
          capacityScheduledEscalation: true,
          sourceResultAttemptIds: candidate.sourceResultAttemptIds,
        });
        const [campaignAfterSubmit] = await db
          .select({ status: simCampaigns.status })
          .from(simCampaigns)
          .where(eq(simCampaigns.id, candidate.ownerCampaignId))
          .limit(1);
        if (campaignAfterSubmit?.status === "paused") {
          // Pause may win after composition but before/while engine submission.
          // Its cancelled child is deliberately NOT a settled obligation: the
          // queued/no-owner rows must be reconsidered after explicit resume in
          // this same process, not only after a restart clears memory.
          settledRecoveryParents.delete(parent.id);
          continue;
        }
        const beforeIds = new Set(before.map((row) => row.id));
        const after = await db
          .select({ id: simJobs.id, status: simJobs.status })
          .from(simJobs)
          .where(and(eq(simJobs.parentJobId, parent.id), eq(simJobs.wave, 2)));
        const created = after.filter((row) => !beforeIds.has(row.id));
        if (!created.length) {
          const [openObligation] = (await db.execute(sql`
            SELECT 1 AS present
            WHERE EXISTS (
              SELECT 1
              FROM sim_jobs sibling_child
              CROSS JOIN LATERAL jsonb_array_elements_text(
                CASE
                  WHEN jsonb_typeof(sibling_child.request_payload -> 'precalcObligationIds') = 'array'
                  THEN sibling_child.request_payload -> 'precalcObligationIds'
                  ELSE '[]'::jsonb
                END
              ) payload_obligation(id)
              JOIN sim_precalc_obligations obligation
                ON obligation.id = payload_obligation.id::uuid
              WHERE sibling_child.parent_job_id = ${parent.id}
                AND obligation.state IN ('pending', 'running')
            ) OR EXISTS (
              -- Covers a crash/failure after ensure but before the child insert.
              -- Scope that durable cell back to THIS parent's rejected RANS
              -- evidence. An unrelated open PRECALC obligation on the same
              -- campaign/revision must not keep every childless no-plan parent
              -- in the first scan window forever.
              SELECT 1
              FROM sim_precalc_obligations obligation
              JOIN sim_precalc_obligation_campaigns ownership
                ON ownership.obligation_id = obligation.id
               AND ownership.state = 'active'
              WHERE ownership.campaign_id = ${candidate.ownerCampaignId}
                AND obligation.airfoil_id = ${parent.airfoilId}
                AND obligation.revision_id = ${parent.simulationPresetRevisionId}
                AND obligation.state IN ('pending', 'running')
                AND (
                  EXISTS (
                    SELECT 1
                    FROM result_attempts parent_attempt
                    JOIN result_classifications classification
                      ON classification.result_attempt_id = parent_attempt.id
                    WHERE parent_attempt.sim_job_id = ${parent.id}
                      AND parent_attempt.regime = 'rans'
                      AND parent_attempt.airfoil_id = obligation.airfoil_id
                      AND parent_attempt.simulation_preset_revision_id = obligation.revision_id
                      AND parent_attempt.aoa_deg = obligation.aoa_deg
                      AND classification.state IN ('rejected', 'needs_urans')
                  )
                  OR EXISTS (
                    SELECT 1
                    FROM results parent_result
                    JOIN result_classifications classification
                      ON classification.result_id = parent_result.id
                    WHERE parent_result.sim_job_id = ${parent.id}
                      AND parent_result.regime = 'rans'
                      AND parent_result.airfoil_id = obligation.airfoil_id
                      AND parent_result.simulation_preset_revision_id = obligation.revision_id
                      AND parent_result.aoa_deg = obligation.aoa_deg
                      AND classification.state IN ('rejected', 'needs_urans')
                  )
                )
            )
            LIMIT 1
          `)) as unknown as Array<{ present: number }>;
          // A retry-wait obligation intentionally produces no child until its
          // due time. It is not a no-plan parent and must remain reachable in
          // this process. Memoize only when all known physical cells settled.
          if (openObligation) settledRecoveryParents.delete(parent.id);
          else settledRecoveryParents.add(parent.id);
          continue;
        }
        if (
          created.some((row) =>
            ["pending", "submitted", "running", "ingesting"].includes(
              row.status,
            ),
          )
        ) {
          // The live child itself is the durable duplicate barrier. Do not memo
          // the parent: once this child settles, another physical obligation on
          // the same parent may need a continuation in this same process.
          settledRecoveryParents.delete(parent.id);
          return true;
        }
        // Even a synchronously-terminal child may have left another cell or its
        // one continuation pending. Re-scan next tick; memoization is reserved
        // for the genuine no-plan branch above.
        settledRecoveryParents.delete(parent.id);
      }
      return false;
    };

    const durableParents = await dueCampaignPrecalcRecoveryParents(
      db,
      campaign.id,
      parentJobIds,
      uransRecoveryVersion,
    );
    if (await attemptParents(durableParents, true)) return true;
    if (attempted >= RECOVERY_PARENTS_PER_TICK) continue;

    // Legacy discovery remains bounded and process-memoized. It materializes
    // obligations for old terminal evidence that predates route recording, but
    // it cannot occupy the admission window ahead of an already-durable route.
    let excludedIds = [
      ...new Set([...settledRecoveryParents, ...attemptedParentIds]),
    ];
    const sharedLegacyParents = await legacySharedCampaignRecoveryParents(
      db,
      campaign.id,
      parentJobIds,
      excludedIds,
      RECOVERY_PARENTS_PER_TICK - attempted,
      uransRecoveryVersion,
    );
    if (await attemptParents(sharedLegacyParents, false)) return true;
    if (attempted >= RECOVERY_PARENTS_PER_TICK) continue;
    excludedIds = [
      ...new Set([...settledRecoveryParents, ...attemptedParentIds]),
    ];
    const child = alias(simJobs, "settled_wave2_child");
    const parents = await db
      .select()
      .from(simJobs)
      .where(
        and(
          eq(simJobs.campaignId, campaign.id),
          eq(simJobs.wave, 1),
          ...(parentJobIds ? [inArray(simJobs.id, parentJobIds)] : []),
          // A cancelled wave-1 parent may already have ingested truthful RANS
          // evidence before its remaining engine work was stopped.  Its
          // rejected cells still owe the campaign a durable precalc attempt;
          // excluding cancelled-but-ingested parents stranded those cells
          // forever (prod campaign 20260710: 21 awaiting-URANS cells).
          or(
            and(
              inArray(simJobs.status, ["done", "failed"]),
              isNotNull(simJobs.ingestedAt),
            ),
            and(
              eq(simJobs.status, "cancelled"),
              or(
                isNotNull(simJobs.ingestedAt),
                // Running-partial ingestion stores immutable attempt evidence
                // but intentionally leaves the terminal-ingest timestamp null.
                // A later admin cancellation must not hide that evidence.
                sql`EXISTS (SELECT 1 FROM result_attempts partial_attempt WHERE partial_attempt.sim_job_id = ${simJobs.id})`,
              ),
            ),
          ),
          ...(excludedIds.length ? [notInArray(simJobs.id, excludedIds)] : []),
          // Only an actually live child blocks this parent. Terminal children
          // are immutable attempt history; a pending sibling obligation must
          // be allowed to drain through the next sequential child.
          notExists(
            db
              .select({ id: child.id })
              .from(child)
              .where(
                and(
                  eq(child.parentJobId, simJobs.id),
                  eq(child.wave, 2),
                  inArray(child.status, [
                    "pending",
                    "submitted",
                    "running",
                    "ingesting",
                  ]),
                ),
              ),
          ),
        ),
      )
      .orderBy(simJobs.finishedAt)
      .limit(RECOVERY_PARENTS_PER_TICK - attempted);
    const legacyParents = parents.map((parent) => ({
      sourceParent: parent,
      ownerCampaignId: campaign.id,
    }));
    if (await attemptParents(legacyParents, false)) return true;
  }
  return false;
}

interface ComposedTarget {
  airfoilId: string;
  revisionId: string;
  snapshot: SimulationSetupSnapshot;
  bcId: string;
}

/** Resolve airfoil + pinned revision snapshot + bc for a ladder job (snapshot
 *  legacy bc first, live preset fallback — the resolveCampaignEntries rule). */
async function resolveTarget(
  db: DB,
  airfoilId: string,
  revisionId: string,
): Promise<ComposedTarget | null> {
  const [revision] = await db
    .select()
    .from(simulationPresetRevisions)
    .where(eq(simulationPresetRevisions.id, revisionId))
    .limit(1);
  if (!revision) return null;
  const snapshot = revision.snapshot as unknown as SimulationSetupSnapshot;
  let bcId = snapshot.preset.legacyBoundaryConditionId ?? null;
  if (!bcId) {
    const [preset] = await db
      .select({
        legacyBoundaryConditionId: simulationPresets.legacyBoundaryConditionId,
      })
      .from(simulationPresets)
      .where(eq(simulationPresets.id, revision.presetId))
      .limit(1);
    bcId = preset?.legacyBoundaryConditionId ?? null;
  }
  if (!bcId) return null;
  return { airfoilId, revisionId, snapshot, bcId };
}

/** Compose + submit one wave-2 URANS ladder job (admin request or verify
 *  item). NO claim flips: existing done rows keep their evidence — a failed
 *  ladder solve must never destroy previously-good coefficients; success
 *  overwrites via the natural-key upsert at ingest. */
async function submitLadderJob(
  db: DB,
  engine: EngineClient,
  opts: {
    target: ComposedTarget;
    aoas: number[];
    fidelity: UransFidelity;
    jobKind: "targeted" | "verify";
    campaignId?: string | null;
    payloadExtras: Record<string, unknown>;
    cpuSlots: number;
    /** Continuation (amendment C): resume the transient of a saved engine case
     *  instead of a fresh solve. Composed into the request as
     *  { continue_from: { engine_job_id, case_slug } }. */
    continueFrom?: { engineJobId: string; caseSlug: string } | null;
    /** Continuation budget override [s] — replaces the tier-derived budget. */
    budgetOverrideS?: number | null;
    /** Live engine capability stamped into PRECALC execution provenance. */
    meshRecoveryVersion?: number;
    /** Exact live durable URANS recovery contract. Required only when this
     * composition resumes/retries physical work unavailable to legacy engines. */
    uransRecoveryVersion?: number;
    /** Claimed admin request linked to the composed job before submit. */
    uransRequestId?: string;
    /** Claimed automatic full-verification item. */
    verifyQueueId?: string;
    /** Explicit only for the one-shot operator canary. Ordinary ladder work
     * remains local and therefore requires the scheduler switch to be on. */
    admissionLane?: SubmissionAdmissionLane;
    /** Crash recovery for one normalized whole-polar event. The exact event
     * and selected obligation ids are revalidated by the child composer in
     * the same transaction as insertion. */
    recordedPromotion?: {
      promotionId: string;
      parentJobId: string;
      conditionId: string | null;
      obligationIds: string[];
    };
  },
): Promise<{
  jobId: string;
  submitted: boolean;
  connectionFailure: boolean;
  lifecycleStopped: boolean;
  submissionInProgress: boolean;
  capabilityMismatch?: boolean;
  error?: string;
  httpStatus?: number | null;
  ladderDisposition?: "retry_wait" | "blocked" | null;
}> {
  if (opts.fidelity === "full" && opts.uransRequestId) {
    throw new Error(
      "direct full-fidelity request submission is forbidden; route through preliminary coverage and a verify queue item",
    );
  }
  const {
    target,
    aoas,
    fidelity,
    jobKind,
    campaignId,
    payloadExtras,
    cpuSlots,
  } = opts;
  const meshRecoveryVersion =
    fidelity === "precalc"
      ? (opts.meshRecoveryVersion ?? (await engineMeshRecoveryVersion(engine)))
      : null;
  if (fidelity === "precalc" && meshRecoveryVersion == null) {
    return {
      jobId: "",
      submitted: false,
      connectionFailure: true,
      lifecycleStopped: false,
      submissionInProgress: false,
      error:
        "engine mesh-recovery capability is unavailable or malformed; PRECALC submission deferred",
    };
  }
  assertNoReservedLadderPayloadKeys(payloadExtras);
  const [a] = await db
    .select()
    .from(airfoils)
    .where(eq(airfoils.id, target.airfoilId))
    .limit(1);
  if (!a) {
    return {
      jobId: "",
      submitted: false,
      connectionFailure: false,
      lifecycleStopped: false,
      submissionInProgress: false,
      error: `airfoil ${target.airfoilId} not found`,
    };
  }
  let executionPool;
  try {
    executionPool = await requireExecutionPoolForSetup(db, target.snapshot);
  } catch (error) {
    if (!(error instanceof SolverExecutionPoolUnavailableError)) throw error;
    return {
      jobId: "",
      submitted: false,
      connectionFailure: false,
      lifecycleStopped: false,
      submissionInProgress: false,
      error: error.message,
    };
  }
  const { request, speed } = buildPolarRequest({
    airfoil: a,
    setup: target.snapshot,
    aoaList: aoas,
    wave: 2,
    uransFidelity: fidelity,
    cpuSlots,
  });
  request.expected_execution_pool = executionPool.routingKey;
  // Ladder jobs are URANS-BY-DEFINITION: the in-job steady stage is only the
  // designed warm-start init, never the reported result. Pin the transient
  // flags locally instead of relying on buildPolarRequest's wave-2 inference —
  // a ladder request shipped without solver.force_transient runs URANS on the
  // FULL mesh at this tier's budget (the engine's half-mesh derivation,
  // src/airfoilfoam/models.py effective_mesh_params, requires
  // force_transient && precalc), which structurally guarantees
  // insufficient-periods (budget) rejections (prod job e89be2bb).
  // MUST-CATCH payload-shape pins: urans-ladder.test.ts.
  request.solver = {
    ...request.solver,
    transient_fallback: true,
    force_transient: true,
    urans_fidelity: fidelity,
  };
  if (fidelity === "precalc") {
    request.expected_mesh_recovery_version = meshRecoveryVersion!;
  }
  if (opts.uransRecoveryVersion != null) {
    request.expected_urans_recovery_version = opts.uransRecoveryVersion;
  }
  if (opts.continueFrom) {
    // Amendment C: the engine copies/links the saved case dir into the new
    // job and restarts the transient from latestTime, merging coefficient
    // history (the existing restart-segment machinery, across jobs).
    // MUST-CATCH payload-shape pin: urans-ladder-continuation test.
    request.continue_from = {
      engine_job_id: opts.continueFrom.engineJobId,
      case_slug: opts.continueFrom.caseSlug,
    };
    if (opts.budgetOverrideS != null)
      request.budget_override_s = opts.budgetOverrideS;
  }
  const jobValues: typeof simJobs.$inferInsert = {
    parentJobId: opts.recordedPromotion?.parentJobId ?? null,
    airfoilId: a.id,
    bcIds: [target.bcId],
    simulationPresetRevisionId: target.revisionId,
    solverImplementationId: solverImplementationIdForSetup(target.snapshot),
    solverExecutionPoolId: executionPool.id,
    methodKey: "openfoam.urans",
    campaignId: campaignId ?? null,
    jobKind,
    referenceChordM: target.snapshot.referenceGeometry.referenceLengthM,
    wave: 2,
    status: "pending",
    totalCases: aoas.length,
    requestPayload: {
      ...payloadExtras,
      speedMap: [
        {
          speed,
          bcId: target.bcId,
          presetRevisionId: target.revisionId,
          mach: target.snapshot.flowState.mach,
        },
      ],
      aoas,
      uransFidelity: fidelity,
      ...(fidelity === "precalc"
        ? { meshRecoveryVersion: meshRecoveryVersion! }
        : {}),
      ...(opts.uransRecoveryVersion != null
        ? { uransRecoveryVersion: opts.uransRecoveryVersion }
        : {}),
      resources: request.resources,
      setupSnapshot: target.snapshot,
    },
  };
  const payloadObligationIds = Array.isArray(
    (payloadExtras as { precalcObligationIds?: unknown }).precalcObligationIds,
  )
    ? (
        payloadExtras as { precalcObligationIds: unknown[] }
      ).precalcObligationIds.filter(
        (id): id is string => typeof id === "string",
      )
    : [];
  if (
    opts.recordedPromotion &&
    ([...payloadObligationIds].sort().join(",") !==
      [...opts.recordedPromotion.obligationIds].sort().join(",") ||
      payloadObligationIds.length !==
        opts.recordedPromotion.obligationIds.length)
  ) {
    throw new Error(
      "recorded promotion recovery payload does not match its selected obligation ids",
    );
  }
  const job = payloadObligationIds.length
    ? await composePhysicalPrecalcJob(db, {
        obligationIds: payloadObligationIds,
        job: jobValues,
        ...(opts.recordedPromotion
          ? {
              directParent: {
                parentJobId: opts.recordedPromotion.parentJobId,
                revisionId: target.revisionId,
                conditionId: opts.recordedPromotion.conditionId ?? undefined,
                recordedPromotionId: opts.recordedPromotion.promotionId,
              },
            }
          : {}),
      })
    : (
        await db.insert(simJobs).values(jobValues).returning({ id: simJobs.id })
      )[0];
  if (!job) {
    return {
      jobId: "",
      submitted: false,
      connectionFailure: false,
      lifecycleStopped: true,
      submissionInProgress: false,
      error:
        "physical precalc obligation is already claimed or no longer runnable",
    };
  }
  if (opts.uransRequestId || opts.verifyQueueId) {
    const ownerBound = await db.transaction(async (tx) => {
      let bound = false;
      if (opts.uransRequestId) {
        const rows = await tx
          .update(simUransRequests)
          .set({ simJobId: job.id })
          .where(
            and(
              eq(simUransRequests.id, opts.uransRequestId),
              eq(simUransRequests.state, "running"),
            ),
          )
          .returning({ id: simUransRequests.id });
        bound = rows.length === 1;
      }
      if (opts.verifyQueueId) {
        const rows = await tx
          .update(simUransVerifyQueue)
          .set({ simJobId: job.id })
          .where(
            and(
              eq(simUransVerifyQueue.id, opts.verifyQueueId),
              eq(simUransVerifyQueue.state, "running"),
            ),
          )
          .returning({ id: simUransVerifyQueue.id });
        bound = rows.length === 1;
      }
      if (bound && fidelity === "full") {
        await tx
          .update(simLadderSubmitRetries)
          .set({ latestSimJobId: job.id })
          .where(
            and(
              eq(simLadderSubmitRetries.state, "retry_wait"),
              opts.uransRequestId
                ? and(
                    eq(
                      simLadderSubmitRetries.uransRequestId,
                      opts.uransRequestId,
                    ),
                    sql`EXISTS (
                      SELECT 1 FROM sim_urans_requests current_request
                      WHERE current_request.id = ${opts.uransRequestId}
                        AND current_request.state = 'running'
                        AND current_request.sim_job_id = ${job.id}
                    )`,
                  )
                : and(
                    eq(
                      simLadderSubmitRetries.verifyQueueId,
                      opts.verifyQueueId!,
                    ),
                    sql`EXISTS (
                      SELECT 1 FROM sim_urans_verify_queue current_verify
                      WHERE current_verify.id = ${opts.verifyQueueId!}
                        AND current_verify.state = 'running'
                        AND current_verify.sim_job_id = ${job.id}
                    )`,
                  ),
            ),
          );
      }
      return bound;
    });
    if (!ownerBound) {
      await db
        .update(simJobs)
        .set({
          status: "cancelled",
          engineState: "cancelled",
          error: "ladder owner changed before job binding",
          finishedAt: new Date(),
        })
        .where(and(eq(simJobs.id, job.id), eq(simJobs.status, "pending")));
      return {
        jobId: job.id,
        submitted: false,
        connectionFailure: false,
        lifecycleStopped: true,
        submissionInProgress: false,
        error: "ladder owner changed before job binding",
      };
    }
  }
  const submit = await submitPendingJobWithLifecycleGuard({
    db,
    engine,
    jobId: job.id,
    admissionLane: opts.admissionLane,
    campaignId: campaignId ?? null,
    request,
    connectionErrorPrefix: "engine unreachable at ladder submit: ",
    submitErrorPrefix: "ladder submit failed: ",
    precalcObligationIds: payloadObligationIds,
    ...(fidelity === "full" && opts.verifyQueueId
      ? { ladderSubmitOwner: { verifyQueueId: opts.verifyQueueId } }
      : {}),
  });
  if (submit.kind === "submitted") {
    return {
      jobId: job.id,
      submitted: true,
      connectionFailure: false,
      lifecycleStopped: false,
      submissionInProgress: false,
    };
  }
  if (submit.kind === "connection_failure") {
    await recordEngineUnreachable(db);
    return {
      jobId: job.id,
      submitted: false,
      connectionFailure: true,
      lifecycleStopped: false,
      submissionInProgress: false,
      error: submit.error,
    };
  }
  if (submit.kind === "capability_mismatch") {
    console.warn(
      `[sweeper] PRECALC job ${job.id} deferred by engine capability cutover; capability will be re-probed next tick`,
    );
    return {
      jobId: job.id,
      submitted: false,
      connectionFailure: false,
      lifecycleStopped: false,
      submissionInProgress: false,
      capabilityMismatch: true,
      error: submit.error,
    };
  }
  if (submit.kind === "lifecycle_stopped") {
    return {
      jobId: job.id,
      submitted: false,
      connectionFailure: false,
      lifecycleStopped: true,
      submissionInProgress: false,
      error: submit.error,
    };
  }
  if (submit.kind === "submission_in_progress") {
    return {
      jobId: job.id,
      submitted: false,
      connectionFailure: false,
      lifecycleStopped: false,
      submissionInProgress: true,
    };
  }
  return {
    jobId: job.id,
    submitted: false,
    connectionFailure: false,
    lifecycleStopped: false,
    submissionInProgress: false,
    error: submit.error,
    httpStatus: submit.httpStatus,
    ladderDisposition: submit.ladderDisposition,
  };
}

async function blockFullRequestOrchestration(
  db: DB,
  input: {
    requestId: string;
    revisionId: string;
    reason: string;
    error: string;
  },
): Promise<void> {
  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const [blocked] = await tx
      .update(simUransRequests)
      .set({ state: "blocked", simJobId: null })
      .where(
        and(
          eq(simUransRequests.id, input.requestId),
          eq(simUransRequests.fidelity, "full"),
          eq(simUransRequests.state, "running"),
        ),
      )
      .returning({ id: simUransRequests.id });
    if (!blocked) return;
    const [revision] = await tx
      .select({
        solverImplementationId:
          simulationPresetRevisions.solverImplementationId,
      })
      .from(simulationPresetRevisions)
      .where(eq(simulationPresetRevisions.id, input.revisionId))
      .limit(1);
    await recordSolverIncidentInTransaction(tx, {
      stage: "final",
      reason: input.reason,
      severity: "critical",
      owner: { uransRequestId: input.requestId },
      solverImplementationId:
        revision?.solverImplementationId ??
        LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID,
      occurrenceKey: `final-request:${input.requestId}:${input.reason}`,
      remediationVersion: URANS_RECOVERY_REMEDIATION_VERSION,
      metadata: { orchestrationError: input.error },
    });
  });
}

/** Tier-2b: consume ONE pending admin request-URANS item (contract 6).
 *  aoaDeg NULL = whole polar (the pinned revision's sweep angle grid). */
async function consumeUransRequest(
  db: DB,
  engine: EngineClient,
  cpuSlots: number,
  requestIds?: string[],
  meshRecoveryVersion?: number,
  uransRecoveryVersion?: number | null,
  requiredFidelity?: UransFidelity,
  admissionLane?: SubmissionAdmissionLane,
): Promise<boolean> {
  const request = await claimNextPendingUransRequest(db, {
    requestIds,
    fidelity: requiredFidelity,
  });
  if (!request) return false;
  const requestedFidelity: UransFidelity =
    request.fidelity === "full" ? "full" : "precalc";
  let physicalFidelity: UransFidelity = requestedFidelity;
  const durableRecoveryAvailable =
    supportsDurableUransRecovery(uransRecoveryVersion);
  if (
    requestedFidelity === "precalc" &&
    request.continueFromResultId &&
    !durableRecoveryAvailable
  ) {
    await releaseClaimedUransRequest(db, request.id);
    return false;
  }
  const target = await resolveTarget(db, request.airfoilId, request.revisionId);
  if (!target) {
    console.error(
      `[sweeper] URANS request ${request.id} ${requestedFidelity === "full" ? "critically blocked" : "cancelled"}: revision ${request.revisionId} unresolvable (missing revision or bc)`,
    );
    if (requestedFidelity === "full") {
      await blockFullRequestOrchestration(db, {
        requestId: request.id,
        revisionId: request.revisionId,
        reason: "immutable-setup-unresolvable",
        error: `revision ${request.revisionId} is missing or has no resolvable boundary profile`,
      });
      return false;
    }
    await db
      .update(simUransRequests)
      .set({ state: "cancelled" })
      .where(eq(simUransRequests.id, request.id));
    return false;
  }
  // Continuation (amendment C): the request pins the SOURCE results row whose
  // saved engine case the resumed transient restarts from. The source row must
  // still carry its engine addressing (engine_job_id + engine_case_slug) —
  // without it there is no case state to resume, so the item cancels loudly
  // instead of pretending a fresh solve is a continuation.
  let continueFrom: { engineJobId: string; caseSlug: string } | null = null;
  let effectiveBudgetOverrideS =
    requestedFidelity === "precalc" ? (request.budgetOverrideS ?? null) : null;
  let aoas: number[];
  if (requestedFidelity === "precalc" && request.continueFromResultId) {
    const sourceJob = alias(simJobs, "continuation_source_job");
    const sourceRevision = alias(
      simulationPresetRevisions,
      "continuation_source_revision",
    );
    const [source] = await db
      .select({
        aoaDeg: results.aoaDeg,
        engineJobId: results.engineJobId,
        engineCaseSlug: results.engineCaseSlug,
        revisionId: results.simulationPresetRevisionId,
        solverImplementationId: results.solverImplementationId,
        jobSolverImplementationId: sourceJob.solverImplementationId,
        revisionSolverImplementationId: sourceRevision.solverImplementationId,
      })
      .from(results)
      .leftJoin(sourceJob, eq(sourceJob.id, results.simJobId))
      .leftJoin(
        sourceRevision,
        eq(sourceRevision.id, results.simulationPresetRevisionId),
      )
      .where(eq(results.id, request.continueFromResultId))
      .limit(1);
    if (!source || !source.engineJobId || !source.engineCaseSlug) {
      console.error(
        `[sweeper] URANS request ${request.id} cancelled: continuation source ${request.continueFromResultId} has no saved case state (row missing or engine ids absent)`,
      );
      await db
        .update(simUransRequests)
        .set({ state: "cancelled" })
        .where(eq(simUransRequests.id, request.id));
      return false;
    }
    const targetImplementationId = normalizedContinuationImplementationId(
      solverImplementationIdForSetup(target.snapshot),
    );
    const incompatibleSource =
      source.revisionId !== request.revisionId ||
      normalizedContinuationImplementationId(
        source.revisionSolverImplementationId,
      ) !== targetImplementationId ||
      (source.solverImplementationId != null &&
        normalizedContinuationImplementationId(
          source.solverImplementationId,
        ) !== targetImplementationId) ||
      (source.jobSolverImplementationId != null &&
        normalizedContinuationImplementationId(
          source.jobSolverImplementationId,
        ) !== targetImplementationId);
    if (incompatibleSource) {
      console.error(
        `[sweeper] URANS request ${request.id} cancelled: continuation source ${request.continueFromResultId} does not match target revision ${request.revisionId} solver implementation`,
      );
      await db
        .update(simUransRequests)
        .set({ state: "cancelled" })
        .where(eq(simUransRequests.id, request.id));
      return false;
    }
    continueFrom = {
      engineJobId: source.engineJobId,
      caseSlug: source.engineCaseSlug,
    };
    aoas = [request.aoaDeg ?? source.aoaDeg];
  } else {
    aoas =
      request.aoaDeg != null ? [request.aoaDeg] : snapshotAoas(target.snapshot);
  }
  if (!aoas.length) {
    console.error(
      `[sweeper] URANS request ${request.id} ${requestedFidelity === "full" ? "critically blocked" : "cancelled"}: no angles derivable from the pinned revision sweep`,
    );
    if (requestedFidelity === "full") {
      await blockFullRequestOrchestration(db, {
        requestId: request.id,
        revisionId: request.revisionId,
        reason: "immutable-sweep-empty",
        error: "no angles are derivable from the pinned revision sweep",
      });
      return false;
    }
    await db
      .update(simUransRequests)
      .set({ state: "cancelled" })
      .where(eq(simUransRequests.id, request.id));
    return false;
  }
  let fullCoverage: Awaited<
    ReturnType<typeof ensureFullUransRequestCoverage>
  > | null = null;
  if (requestedFidelity === "full") {
    try {
      fullCoverage = await ensureFullUransRequestCoverage(db, {
        requestId: request.id,
        cells: aoas.map((aoaDeg) => ({
          airfoilId: request.airfoilId,
          revisionId: request.revisionId,
          aoaDeg,
        })),
      });
    } catch (error) {
      if (error instanceof FullUransRequestCoverageIncompleteError) {
        console.warn(
          `[sweeper] full URANS request ${request.id} deferred: ${error.missingCells.length} natural cell(s) are still owned by another queue transition`,
        );
        await releaseClaimedUransRequest(db, request.id);
        return false;
      }
      console.error(
        `[sweeper] full URANS request ${request.id} coverage failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await releaseClaimedUransRequest(db, request.id);
      return false;
    }
    physicalFidelity = "precalc";
    if (
      !fullCoverage.precalcObligations.some((obligation) =>
        ["pending", "running"].includes(obligation.state),
      )
    ) {
      await refreshFullUransRequestState(db, request.id);
      return false;
    }
    if (meshRecoveryVersion == null) {
      // A final request never skips its required fast-URANS baseline. Leave
      // the aggregate pending while the rolling engine cutover cannot execute
      // preliminary recovery; unrelated ready final verification may proceed.
      await refreshFullUransRequestState(db, request.id);
      return false;
    }
  }
  let obligationIds: string[] = [];
  let obligationContinuationResultAttemptId: string | null = null;
  if (physicalFidelity === "precalc") {
    const campaignIds = await activeCampaignOwnersForUransRequest(
      db,
      request.id,
    );
    const obligations =
      fullCoverage?.precalcObligations ??
      (await ensurePrecalcObligations(
        db,
        aoas.map((aoaDeg) => ({
          airfoilId: request.airfoilId,
          revisionId: request.revisionId,
          aoaDeg,
          sourceResultId: request.continueFromResultId,
        })),
        { campaignIds, requestIds: [request.id] },
      ));
    const continuations = await precalcContinuationsForObligations(
      db,
      obligations
        .filter((obligation) => obligation.state === "pending")
        .map((obligation) => obligation.id),
    );
    const continuationIds = new Set(
      continuations.map((continuation) => continuation.obligationId),
    );
    const schedulable = obligations.filter(
      (obligation) =>
        obligation.state === "pending" &&
        (continuationIds.has(obligation.id)
          ? durableRecoveryAvailable
          : obligation.attemptCount < obligation.maxAttempts) &&
        (!obligation.nextSubmitAt ||
          new Date(obligation.nextSubmitAt).getTime() <= Date.now()),
    );
    if (!schedulable.length) {
      if (
        obligations.some(
          (obligation) =>
            obligation.state === "pending" &&
            (continuationIds.has(obligation.id)
              ? durableRecoveryAvailable
              : obligation.attemptCount < obligation.maxAttempts),
        )
      ) {
        // A first answered 5xx owns one durable backoff. Keep the request
        // claimable, but do not spin a new engine composition before it is due.
        await releaseClaimedUransRequest(db, request.id);
        return false;
      }
      if (requestedFidelity === "full") {
        await refreshFullUransRequestState(db, request.id);
      } else {
        const requestState = await precalcRequestStateFromObligations(
          db,
          request.id,
        );
        await db
          .update(simUransRequests)
          .set({ state: requestState, simJobId: null })
          .where(eq(simUransRequests.id, request.id));
      }
      return false;
    }
    const schedulableAoas = new Set(
      schedulable.map((obligation) => obligation.aoaDeg),
    );
    aoas = aoas.filter((aoa) => schedulableAoas.has(aoa));
    obligationIds = schedulable.map((obligation) => obligation.id);
    const latestContinuation = durableRecoveryAvailable
      ? continuations.find((continuation) =>
          obligationIds.includes(continuation.obligationId),
        )
      : undefined;
    if (latestContinuation) {
      aoas = [latestContinuation.aoaDeg];
      obligationIds = [latestContinuation.obligationId];
      continueFrom = {
        engineJobId: latestContinuation.engineJobId,
        caseSlug: latestContinuation.engineCaseSlug,
      };
      obligationContinuationResultAttemptId =
        latestContinuation.resultAttemptId;
      effectiveBudgetOverrideS = latestContinuation.budgetOverrideS;
    }
  }
  const outcome = await submitLadderJob(db, engine, {
    target,
    aoas,
    fidelity: physicalFidelity,
    jobKind: "targeted",
    // Physical continuation work is global; campaign ownership stays on the
    // request association rows so one campaign cannot cancel shared evidence.
    campaignId: null,
    payloadExtras: {
      uransRequestId: request.id,
      ...(obligationIds.length ? { precalcObligationIds: obligationIds } : {}),
      ...(obligationContinuationResultAttemptId
        ? {
            continueFromResultAttemptId: obligationContinuationResultAttemptId,
            budgetOverrideS: effectiveBudgetOverrideS,
          }
        : {}),
      ...(requestedFidelity === "precalc" && request.continueFromResultId
        ? {
            continueFromResultId: request.continueFromResultId,
            budgetOverrideS: request.budgetOverrideS ?? null,
          }
        : {}),
    },
    cpuSlots,
    continueFrom,
    budgetOverrideS: effectiveBudgetOverrideS,
    meshRecoveryVersion,
    uransRecoveryVersion: continueFrom
      ? (uransRecoveryVersion ?? undefined)
      : undefined,
    uransRequestId: request.id,
    admissionLane,
  });
  if (outcome.submitted) {
    if (obligationIds.length) {
      await recordPrecalcObligationSubmission(db, outcome.jobId, obligationIds);
    }
    await db
      .update(simUransRequests)
      .set({ state: "running", simJobId: outcome.jobId })
      .where(eq(simUransRequests.id, request.id));
    console.log(
      `[sweeper] URANS request ${request.id} submitted (${physicalFidelity}${requestedFidelity === "full" ? " preliminary stage for requested full fidelity" : ""}, ${aoas.length} angle(s), job ${outcome.jobId}${
        continueFrom
          ? `, CONTINUATION of engine ${continueFrom.engineJobId}/${continueFrom.caseSlug}${request.budgetOverrideS ? ` with budget override ${request.budgetOverrideS}s` : ""}`
          : ""
      })`,
    );
    return true;
  }
  if (outcome.submissionInProgress) return true;
  if (outcome.capabilityMismatch) {
    await releaseClaimedUransRequest(db, request.id);
    return false;
  }
  if (outcome.connectionFailure || outcome.lifecycleStopped) {
    await releaseClaimedUransRequest(db, request.id);
    return false;
  }
  if (obligationIds.length) {
    if (requestedFidelity === "full") {
      await refreshFullUransRequestState(db, request.id);
    } else {
      const requestState = await precalcRequestStateFromObligations(
        db,
        request.id,
      );
      await db
        .update(simUransRequests)
        .set({ state: requestState, simJobId: null })
        .where(eq(simUransRequests.id, request.id));
    }
    return false;
  }
  console.error(
    `[sweeper] URANS request ${request.id} ${outcome.ladderDisposition === "retry_wait" ? "waiting for its one automatic submit retry" : "blocked"}: engine rejected the submit (${outcome.error})`,
  );
  // Full-request owner + durable retry ledger were settled atomically with the
  // failed sim_job. Never rewrite accepted result evidence or downgrade this
  // machine-terminal outcome into a review/cancel placeholder here.
  return false;
}

/** Consume ONE pending verify-queue item (contract 4). The caller owns whether
 * this is the bounded RANS interleave or the idle-capacity fallback. */
async function consumeVerifyItem(
  db: DB,
  engine: EngineClient,
  cpuSlots: number,
  scope: {
    campaignIds?: string[];
    verifyIds?: string[];
    uransRecoveryVersion?: number | null;
    admissionLane?: SubmissionAdmissionLane;
  } = {},
): Promise<boolean> {
  const durableRecoveryAvailable = supportsDurableUransRecovery(
    scope.uransRecoveryVersion,
  );
  const item = await claimNextPendingVerifyItem(db, {
    ...scope,
    allowAutomaticRecovery: durableRecoveryAvailable,
  });
  if (!item) return false;
  const precalc = await precalcSnapshotForVerifyItem(db, item);
  if (!precalc) {
    // Runnable queue rows own one exact immutable accepted preliminary
    // attempt. Missing/mismatched evidence is a controller invariant breach;
    // never fall back to whichever generation the mutable results row selects.
    console.error(
      `[sweeper] verify item ${item.id} cancelled: exact preliminary attempt ${item.precalcResultAttemptId ?? "missing"} is not accepted urans_precalc evidence for result ${item.precalcResultId}`,
    );
    await db
      .update(simUransVerifyQueue)
      .set({ state: "cancelled", simJobId: null })
      .where(eq(simUransVerifyQueue.id, item.id));
    return false;
  }
  const target = await resolveTarget(db, item.airfoilId, item.revisionId);
  if (!target) {
    console.error(
      `[sweeper] verify item ${item.id} cancelled: revision ${item.revisionId} unresolvable (missing revision or bc)`,
    );
    await db
      .update(simUransVerifyQueue)
      .set({ state: "cancelled", simJobId: null })
      .where(eq(simUransVerifyQueue.id, item.id));
    return false;
  }
  let recovery = await finalUransRecoveryPlanForVerifyItem(db, item);
  if (recovery.mode === "media_repair") {
    await releaseClaimedVerifyItem(db, item.id);
    return false;
  }
  if (recovery.mode === "exhausted") {
    const blocked = await blockFinalUransVerificationBeforeSubmit(db, {
      verifyQueueId: item.id,
      reason: recovery.reason,
      incidentReason: "recovery-budget-exhausted",
      targetSolverImplementationId: solverImplementationIdForSetup(
        target.snapshot,
      ),
    });
    if (blocked) {
      console.error(
        `[sweeper] FINAL URANS CRITICAL (item ${item.id}, aoa ${item.aoaDeg}): ${recovery.reason}. Accepted preliminary evidence remains selected.`,
      );
    }
    return false;
  }
  if (recovery.mode === "continuation") {
    const targetImplementationId = normalizedContinuationImplementationId(
      solverImplementationIdForSetup(target.snapshot),
    );
    const sourceImplementationId = normalizedContinuationImplementationId(
      recovery.solverImplementationId,
    );
    if (
      !targetImplementationId ||
      !sourceImplementationId ||
      targetImplementationId !== sourceImplementationId
    ) {
      recovery =
        item.freshAttemptCount < item.maxFreshAttempts
          ? { mode: "fresh" }
          : {
              mode: "exhausted",
              reason:
                "saved full-URANS checkpoint belongs to a different solver implementation and no fresh recovery start remains",
            };
      if (recovery.mode === "exhausted") {
        const blocked = await blockFinalUransVerificationBeforeSubmit(db, {
          verifyQueueId: item.id,
          reason: recovery.reason,
          incidentReason: "solver-implementation-mismatch",
          targetSolverImplementationId:
            targetImplementationId ??
            sourceImplementationId ??
            solverImplementationIdForSetup(target.snapshot),
          metadata: {
            sourceSolverImplementationId: sourceImplementationId,
          },
        });
        if (blocked) {
          console.error(
            `[sweeper] FINAL URANS CRITICAL (item ${item.id}, aoa ${item.aoaDeg}): ${recovery.reason}. Accepted preliminary evidence remains selected.`,
          );
        }
        return false;
      }
    }
  }
  const continuation =
    recovery.mode === "continuation"
      ? {
          engineJobId: recovery.engineJobId,
          caseSlug: recovery.engineCaseSlug,
        }
      : null;
  const budgetOverrideS =
    recovery.mode === "continuation" ? recovery.budgetOverrideS : null;
  const usesAutomaticRecoveryContract =
    recovery.mode === "continuation" ||
    item.freshAttemptCount > 0 ||
    item.continuationAttemptCount > 0 ||
    item.lastOutcome === FINAL_URANS_OUTCOMES.continuationPending ||
    item.lastOutcome === FINAL_URANS_OUTCOMES.continuationRetryWait ||
    item.lastOutcome === FINAL_URANS_OUTCOMES.freshRetryPending;
  const outcome = await submitLadderJob(db, engine, {
    target,
    aoas: [item.aoaDeg],
    fidelity: "full",
    jobKind: "verify",
    // One physical verification job serves every associated campaign and/or
    // the background owner. Never stamp an arbitrary campaign on the job.
    campaignId: null,
    payloadExtras: {
      verifyQueueItemId: item.id,
      verifyPrecalcResultAttemptId: precalc.resultAttemptId,
      verifyPrecalc: {
        cl: precalc.cl,
        cd: precalc.cd,
        cm: precalc.cm,
      },
      finalRecoveryMode: recovery.mode,
      ...(recovery.mode === "continuation"
        ? {
            continueFromResultAttemptId: recovery.resultAttemptId,
            budgetOverrideS,
          }
        : {}),
    },
    cpuSlots,
    continueFrom: continuation,
    budgetOverrideS,
    uransRecoveryVersion: usesAutomaticRecoveryContract
      ? (scope.uransRecoveryVersion ?? undefined)
      : undefined,
    verifyQueueId: item.id,
    admissionLane: scope.admissionLane,
  });
  if (outcome.submitted) {
    console.log(
      `[sweeper] verify item ${item.id} submitted (aoa ${item.aoaDeg}, full fidelity, ${recovery.mode}, job ${outcome.jobId})`,
    );
    return true;
  }
  if (outcome.connectionFailure || outcome.lifecycleStopped) {
    await releaseClaimedVerifyItem(db, item.id);
    return false; // pending for a live/paused campaign; backoff/compensation recorded
  }
  if (outcome.capabilityMismatch) return false;
  if (outcome.submissionInProgress) return true;
  console.error(
    `[sweeper] verify item ${item.id} ${outcome.ladderDisposition === "retry_wait" ? "waiting for its one automatic submit retry" : "blocked"}: engine rejected the submit (${outcome.error})`,
  );
  // The submit boundary owns the retry/blocked transition. The accepted
  // preliminary result remains untouched and visible while verification is
  // terminally unavailable.
  return false;
}

/**
 * Admit at most one physical step of one pre-validated three-stage canary.
 *
 * Unlike `uransLadderTick`, this entry point deliberately has no campaign,
 * RANS-parent, promotion, or unscoped-admin lane. The caller supplies one
 * exact FULL request and, once preliminary evidence creates it, the one exact
 * verification item. Automatic same-case continuation remains enabled only
 * inside those exact owners. This is the narrow operator boundary used while
 * the normal sweeper's durable switch remains disabled.
 */
export async function submitExactUransCanaryStep(
  db: DB,
  engine: EngineClient,
  input: {
    requestId: string;
    verifyId?: string | null;
    cpuSlots?: number;
    meshRecoveryVersion: number;
    uransRecoveryVersion: number;
  },
): Promise<boolean> {
  await healOrphanedUransRequests(db, { requestIds: [input.requestId] });
  if (input.verifyId) {
    await healOrphanedVerifyItems(db, { verifyIds: [input.verifyId] });
  }

  if (supportsDurableUransRecovery(input.uransRecoveryVersion)) {
    await requeueRestartablePrecalcContinuations(db, {
      requestIds: [input.requestId],
    });
  }

  if (
    await consumeUransRequest(
      db,
      engine,
      input.cpuSlots ?? 0,
      [input.requestId],
      input.meshRecoveryVersion,
      input.uransRecoveryVersion,
      undefined,
      "operator_canary",
    )
  ) {
    return true;
  }

  if (!input.verifyId) return false;
  return consumeVerifyItem(db, engine, input.cpuSlots ?? 0, {
    verifyIds: [input.verifyId],
    uransRecoveryVersion: input.uransRecoveryVersion,
    admissionLane: "operator_canary",
  });
}

/** Give final verification its bounded restart-safe share of admission.
 * Promotion and targeted preliminary recovery call sites run before this
 * helper. The decision is reconstructed from submitted DB job history, so a
 * sweeper restart cannot reset or accidentally extend the eight-RANS bound. */
export async function submitInterleavedVerifyIfDue(
  db: DB,
  engine: EngineClient,
  cpuSlots = 0,
  scope: VerifyInterleaveScope & {
    uransRecoveryVersion?: number | null;
  } = {},
): Promise<boolean> {
  const durableRecoveryAvailable = supportsDurableUransRecovery(
    scope.uransRecoveryVersion,
  );
  const decision = await finalVerifyInterleaveDecision(db, {
    ...scope,
    allowAutomaticRecovery: durableRecoveryAvailable,
  });
  if (!decision.due) return false;
  return consumeVerifyItem(db, engine, cpuSlots, {
    campaignIds: scope.campaignIds,
    verifyIds: scope.verifyIds,
    uransRecoveryVersion: scope.uransRecoveryVersion,
  });
}

/** One ladder pass: heal orphans, then submit AT MOST one piece of work in
 *  tier order (campaign PRECALC recovery → admin requests → verify queue).
 *  The main loop gives durable campaign recovery a pre-RANS pass; this
 *  fallback preserves recovery when the RANS branch leaves capacity unused.
 *  Exported cpuSlots plumbed from
 *  sweeper_state like the RANS branch. */
export async function uransLadderTick(
  db: DB,
  engine: EngineClient,
  cpuSlots = 0,
  /** Test-harness scoping for parallel files sharing one dev DB. Production
   *  passes nothing and therefore keeps the machine-wide scheduler semantics.
   *  Tests must scope every physical queue they may claim; campaignIds alone
   *  cannot stop an admin request from another file winning tier 2b. */
  opts: {
    campaignIds?: string[];
    /** Test-only closed world for tier-2a's finished-parent window. */
    parentJobIds?: string[];
    /** Test-only closed world for normalized conditional-promotion recovery. */
    promotionIds?: string[];
    requestIds?: string[];
    verifyIds?: string[];
    /** Internal scheduler handoff: capability and global requeue were already
     * prepared earlier in this same tick. */
    /** `null` means this tick reached the engine but could not validate its
     * PRECALC capability. Undefined means the caller has not probed yet. */
    meshRecoveryVersion?: number | null;
    /** Separate rolling-cutover contract for durable URANS continuation and
     * corrective final recovery. Legacy mesh-recovery v1 is insufficient. */
    uransRecoveryVersion?: number | null;
  } = {},
): Promise<boolean> {
  const healedItems = await healOrphanedVerifyItems(db, {
    campaignIds: opts.campaignIds,
    verifyIds: opts.verifyIds,
  });
  if (healedItems > 0)
    console.log(
      `[sweeper] verify queue: ${healedItems} orphaned running item(s) settled by current campaign lifecycle`,
    );
  const healedRequests = await healOrphanedUransRequests(db, {
    requestIds: opts.requestIds,
  });
  if (healedRequests > 0)
    console.log(
      `[sweeper] URANS requests: ${healedRequests} orphaned running request(s) returned to pending`,
    );

  const meshRecoveryVersion =
    opts.meshRecoveryVersion !== undefined
      ? opts.meshRecoveryVersion
      : await prepareAutomaticMeshRecovery(
          db,
          engine,
          opts.promotionIds !== undefined
            ? { promotionIds: opts.promotionIds }
            : opts.campaignIds !== undefined
              ? { campaignIds: opts.campaignIds }
              : {},
        );
  const uransRecoveryVersion =
    opts.uransRecoveryVersion !== undefined
      ? opts.uransRecoveryVersion
      : await engineUransRecoveryVersion(engine);
  const durableRecoveryAvailable =
    supportsDurableUransRecovery(uransRecoveryVersion);

  if (meshRecoveryVersion != null) {
    const continuationRecoveryScope = opts.requestIds?.length
      ? { requestIds: opts.requestIds }
      : opts.promotionIds?.length
        ? { promotionIds: opts.promotionIds }
        : opts.campaignIds !== undefined
          ? { campaignIds: opts.campaignIds }
          : opts.requestIds !== undefined || opts.promotionIds !== undefined
            ? { obligationIds: [] }
            : {};
    if (durableRecoveryAvailable) {
      const continuationRecovery = await requeueRestartablePrecalcContinuations(
        db,
        continuationRecoveryScope,
      );
      if (continuationRecovery.obligationIds.length) {
        console.log(
          `[sweeper] reopened ${continuationRecovery.obligationIds.length} restartable PRECALC obligation(s) for same-case continuation; repaired ${continuationRecovery.repairedSubmissionIds.length} pre-typed infrastructure submission(s) without spending fresh-solve budget`,
        );
      }
    }
    if (
      await submitRecordedPromotionRecovery(db, engine, cpuSlots, {
        ...opts,
        meshRecoveryVersion,
        uransRecoveryVersion,
      })
    )
      return true;
    if (
      await submitCampaignPrecalcRecoveries(
        db,
        engine,
        opts.campaignIds,
        opts.parentJobIds,
        meshRecoveryVersion,
        uransRecoveryVersion,
      )
    )
      return true;
  }
  if (
    await consumeUransRequest(
      db,
      engine,
      cpuSlots,
      opts.requestIds,
      meshRecoveryVersion ?? undefined,
      uransRecoveryVersion,
      meshRecoveryVersion == null ? "full" : undefined,
    )
  )
    return true;
  // Idle-capacity verify fallback: the main scheduler separately applies the
  // restart-safe one-per-eight-RANS interleave before ordinary RANS admission.
  // Outside that bound, verify remains below live campaign RANS/PRECALC work.
  // A supplied requestIds list is a test-only closed world.
  if (
    await hasOpenCampaignLadderWork(db, {
      requestIds: opts.requestIds,
      campaignIds: opts.campaignIds,
      includePrecalc: meshRecoveryVersion != null,
    })
  )
    return false;
  return consumeVerifyItem(db, engine, cpuSlots, {
    campaignIds: opts.campaignIds,
    verifyIds: opts.verifyIds,
    uransRecoveryVersion,
  });
}
