import {
  airfoils,
  autoRetryCrashedResultsForJob,
  type CampaignLaneKey,
  campaignHasOpenRansGaps,
  type DB,
  enqueuePrecalcVerifications,
  ensurePrecalcObligations,
  FINAL_URANS_MAX_NO_PROGRESS_SEGMENTS,
  FINAL_URANS_OUTCOMES,
  FINAL_URANS_RETRY_BACKOFF_MS,
  hasExactValidSolverManifest,
  hasExactVerifiedRestartableEvidenceArchive,
  inspectParentRansPolarPromotions,
  laneKeyId,
  laneTick,
  onResultIngested,
  probeCampaignCompletion,
  precalcContinuationsForObligations,
  precalcContinuationMadeProgress,
  precalcContinuationProgressFromEvidence,
  reconcileCampaigns,
  recomputeProgressForCampaign,
  recordRansPolarPromotion,
  recordPrecalcObligationSubmission,
  recordSolverIncidentInTransaction,
  refreshFullUransRequestState,
  refreshFullUransRequestsForVerifyQueueInTransaction,
  refreshPrecalcSettlementCampaigns,
  refreshPolarCacheForRevision,
  resultAttempts,
  resultClassifications,
  results,
  resolveSolverIncidentsForOwnerInTransaction,
  settleAcceptedRunningPrecalcPartials,
  settlePrecalcObligationsForJob,
  settlePrecalcObligationsForJobInTransaction,
  simCampaignLanes,
  simCampaigns,
  simJobs,
  simulationPresetRevisions,
  syncSweepPromises,
  simUransRequests,
  simUransVerifyQueue,
  solverIncidentReason,
  sweeperState,
  URANS_RECOVERY_REMEDIATION_VERSION,
} from "@aerodb/db";
import {
  EVIDENCE_BACKED_WAVE2_RESULT_SQL,
  releaseResultClaimsForJob,
  releasedResultStatusSql,
} from "@aerodb/db/result-claim-lifecycle";
import type { SimulationSetupSnapshot } from "@aerodb/db/simulation-setup";
import {
  DETERMINISTIC_MESH_BLOCKER_ERROR_MARKER,
  DETERMINISTIC_MESH_BLOCKER_NONORTHO_MARKER,
  MISSING_URANS_VIDEO_REASON,
  URANS_BUDGET_STOP_MARKER,
  URANS_CONTINUATION_REQUIRED_MARKER,
} from "@aerodb/core";
import {
  EngineError,
  URANS_VERIFY_DELTA_CD_LIMIT,
  URANS_VERIFY_DELTA_CL_LIMIT,
  WORKER_RESTART_ORPHAN_MESSAGE,
  classifyQueueLifecycle,
  engineQueueListsJob,
  type EngineClient,
  type EngineQueueState,
  type JobResult,
  type JobRuntimeSummary,
  type JobStatus,
  type UransFidelity,
  isEngineRuntimeIdentity,
} from "@aerodb/engine-client";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm";

import {
  buildPolarRequest,
  solverImplementationIdForSetup,
} from "./build-request";
import {
  engineMeshRecoveryVersion,
  engineUransRecoveryVersion,
  parsedMeshRecoveryVersion,
  supportsDurableUransRecovery,
} from "./engine-capabilities";
import { recordEngineUnreachable } from "./engine-backoff";
import {
  requireExecutionPoolForSetup,
  SolverExecutionPoolUnavailableError,
} from "./engine-pool";
import { persistEngineRuntimeForJob } from "./engine-provenance";
import {
  expectedEngineForJob,
  expectedExecutionPoolForJob,
} from "./engine-routing";
import { touchHeartbeat } from "./heartbeat";
import { composePhysicalPrecalcJob } from "./precalc-composition";
import {
  type ConditionMapEntry,
  failedForPoint,
  type IngestedRansPrecalcPromotion,
  ingestResult,
  TerminalEvidenceCleanupPendingError,
  type SpeedBc,
} from "./ingest";
import {
  claimJobForIngest,
  DEFAULT_INGEST_LEASE_MS,
  type IngestLease,
  IngestLeaseLostError,
  ingestLeaseOwnedWhere,
  releaseIngestLeaseToRunning,
  renewIngestLeaseOrThrow,
} from "./ingest-lease";
import {
  parseRansRetryScope,
  ransRetryPlanForJobScoped,
  type RansRetryDecision,
} from "./retry-plan";
import { submitPendingJobWithLifecycleGuard } from "./submit-lifecycle";

export { touchHeartbeat } from "./heartbeat";

const MISSING_JOB_REQUEUE_MS = Number(
  process.env.SWEEPER_MISSING_JOB_REQUEUE_MS ?? 10 * 60 * 1000,
);
type SimJobRow = typeof simJobs.$inferSelect;
interface ReconcileOptions {
  jobIds?: string[];
  recoverFailedJobIds?: string[];
  skipFailedRecovery?: boolean;
  /** Deterministic crash injection for the durable-ingest regression suite.
   * Production never supplies hooks. The callback runs inside the failure
   * settlement transaction after result rows change but before campaign
   * points/counters are linked, so a thrown error must roll the whole unit
   * back. */
  testHooks?: {
    afterFailedRowsMarked?: () => void | Promise<void>;
  };
}

const activeJobStatuses: Array<"submitted" | "running" | "ingesting"> = [
  "submitted",
  "running",
  "ingesting",
];

export const DEFAULT_ACTIVE_RECONCILE_JOB_LIMIT = 8;
const MAX_ACTIVE_RECONCILE_JOB_LIMIT = 64;

/** Bound one foreground scheduler pass so partial-result ingestion at high
 * concurrency cannot postpone CPU refill until every active polar has been
 * polled. `updatedAt` ordering below rotates the batch: every status/partial
 * update moves a visited job behind older siblings. Explicit test/operator
 * scopes remain exact and are never truncated. */
export function activeReconcileJobLimit(
  raw = process.env.SWEEPER_ACTIVE_RECONCILE_JOB_LIMIT,
): number {
  if (raw == null || raw.trim() === "")
    return DEFAULT_ACTIVE_RECONCILE_JOB_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0)
    return DEFAULT_ACTIVE_RECONCILE_JOB_LIMIT;
  return Math.min(parsed, MAX_ACTIVE_RECONCILE_JOB_LIMIT);
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

// Campaign maintenance state (spec §7/§8): lane keys marked dirty by the
// ingest hooks, drained at the end of every reconcile pass AFTER polar-fit
// refreshes, plus in-memory timers for the 60 s lane safety sweep and the
// low-frequency campaign reconciler.
const LANE_SAFETY_SWEEP_MS = 60_000;
const CAMPAIGN_RECONCILE_MS = 5 * 60_000;
const pendingDirtyLanes = new Map<string, CampaignLaneKey>();
let lastLaneSweepAt = 0;
let lastCampaignReconcileAt = 0;

function collectDirtyLanes(keys: CampaignLaneKey[]): void {
  for (const key of keys) pendingDirtyLanes.set(laneKeyId(key), key);
}

/** Ordinary poll/lost/cancel reconciliation may touch an ingesting row only
 * after its durable lease expired (or a pre-migration tokenless row exceeded
 * the same grace). A live ingest owner is the sole writer until then. */
function outsideLiveIngestLeaseWhere() {
  return sql`(
    ${simJobs.status} <> 'ingesting'
    OR ${simJobs.ingestLeaseExpiresAt} <= now()
    OR (
      ${simJobs.ingestLeaseExpiresAt} IS NULL
      AND ${simJobs.updatedAt} < now() - (${DEFAULT_INGEST_LEASE_MS} * interval '1 millisecond')
    )
  )`;
}

function activeJobWhere(jobId: string) {
  return and(
    eq(simJobs.id, jobId),
    inArray(simJobs.status, activeJobStatuses),
    outsideLiveIngestLeaseWhere(),
  );
}

function reconcilableJobWhere(jobId: string) {
  return and(
    eq(simJobs.id, jobId),
    inArray(simJobs.status, [...activeJobStatuses, "failed"]),
    outsideLiveIngestLeaseWhere(),
  );
}

async function markOwnedJobResultsFailed(
  db: DB,
  jobId: string,
  msg: string,
  lease: Pick<IngestLease, "jobId" | "token">,
  hooks: ReconcileOptions["testHooks"] = {},
): Promise<boolean> {
  // Failed evidence rows must carry WHY: without the error stamp the failures
  // endpoint classifies them 'unknown' (ERROR_CLASS_SQL treats NULL/'' as
  // unknown — incident 2026-07-04: 12 campaign points terminal-failed with
  // empty error). Callers guarantee msg is non-empty (nonEmptyFailureMessage).
  const outcome = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const [owned] = await tx
      .update(simJobs)
      .set({
        error: msg,
      })
      .where(ingestLeaseOwnedWhere(jobId, lease.token))
      .returning({ id: simJobs.id });
    if (!owned)
      return {
        owned: false,
        failedRows: [] as Array<{
          id: string;
          airfoilId: string;
          simulationPresetRevisionId: string | null;
          aoaDeg: number;
        }>,
      };
    // A correction/verification job temporarily owns the scheduling cell, but
    // a pre-existing current attempt remains the canonical public generation.
    // If the child crashes before shipping any attempt, the sim_job/ladder row
    // owns that failure; it must not turn the still-valid selected generation
    // into a failed mutable projection. Reproject every pointer-owned cell from
    // its immutable attempt and detach it from the failed correction job.
    const restoredRows = (await tx.execute(sql`
      UPDATE results result
      SET bc_id = attempt.bc_id,
          status = attempt.status,
          source = attempt.source,
          regime = attempt.regime,
          cl = attempt.cl,
          cd = attempt.cd,
          cm = attempt.cm,
          cl_cd = attempt.cl_cd,
          cl_std = attempt.cl_std,
          cd_std = attempt.cd_std,
          cm_std = attempt.cm_std,
          stalled = attempt.stalled,
          unsteady = attempt.unsteady,
          converged = attempt.converged,
          final_residual = attempt.final_residual,
          iterations = attempt.iterations,
          y_plus_avg = attempt.y_plus_avg,
          y_plus_max = attempt.y_plus_max,
          n_cells = attempt.n_cells,
          first_order_fallback = attempt.first_order_fallback,
          strouhal = attempt.strouhal,
          error = attempt.error,
          quality_warnings = attempt.quality_warnings,
          frame_track = COALESCE(
            NULLIF(attempt.evidence_payload -> 'frame_track', 'null'::jsonb),
            NULLIF(attempt.evidence_payload -> 'frameTrack', 'null'::jsonb),
            result.frame_track
          ),
          fidelity = COALESCE(
            attempt.evidence_payload ->> 'fidelity',
            result.fidelity
          ),
          steady_history = COALESCE(
            NULLIF(attempt.evidence_payload -> 'steady_history', 'null'::jsonb),
            NULLIF(attempt.evidence_payload -> 'steadyHistory', 'null'::jsonb),
            result.steady_history
          ),
          engine_job_id = attempt.engine_job_id,
          engine_case_slug = attempt.engine_case_slug,
          sim_job_id = attempt.sim_job_id,
          "solvedAt" = attempt."solvedAt",
          priority = 0,
          "updatedAt" = now()
      FROM result_attempts attempt
      WHERE result.sim_job_id = ${jobId}
        AND result.status IN ('queued', 'running')
        AND result.current_result_attempt_id = attempt.id
        AND attempt.result_id = result.id
      RETURNING result.id,
                result.airfoil_id,
                result.simulation_preset_revision_id,
                result.aoa_deg,
                result.status::text AS status
    `)) as unknown as Array<{
      id: string;
      airfoil_id: string;
      simulation_preset_revision_id: string | null;
      aoa_deg: number;
      status: "done" | "failed";
    }>;
    const failedRows = await tx
      .update(results)
      .set({ status: "failed", source: "queued", error: msg })
      .where(
        and(
          eq(results.simJobId, jobId),
          inArray(results.status, ["queued", "running"]),
          isNull(results.currentResultAttemptId),
        ),
      )
      .returning({
        id: results.id,
        airfoilId: results.airfoilId,
        simulationPresetRevisionId: results.simulationPresetRevisionId,
        aoaDeg: results.aoaDeg,
      });
    await hooks?.afterFailedRowsMarked?.();
    const dirtyLanes: CampaignLaneKey[] = [];
    let linked = 0;
    for (const row of [
      ...restoredRows.map((restored) => ({
        id: restored.id,
        airfoilId: restored.airfoil_id,
        simulationPresetRevisionId: restored.simulation_preset_revision_id,
        aoaDeg: restored.aoa_deg,
        status: restored.status,
      })),
      ...failedRows.map((failed) => ({ ...failed, status: "failed" as const })),
    ]) {
      // Keep the exclusive ingest lease live for large batched failures. The
      // renewal and heartbeat are in the same transaction as the result and
      // campaign writes, so a rollback cannot leave a false progress stamp.
      if (++linked % 10 === 0) await renewIngestAndHeartbeat(tx, lease);
      dirtyLanes.push(
        ...(await onResultIngested(tx, {
          airfoilId: row.airfoilId,
          revisionId: row.simulationPresetRevisionId,
          aoaDeg: row.aoaDeg,
          resultId: row.id,
          status: row.status,
        })),
      );
    }
    return { owned: true, failedRows, dirtyLanes };
  });
  if (!outcome.owned) return false;
  // Publish dirty lanes only after the transaction commits. A process death
  // after commit but before this in-memory write is recovered by the existing
  // 60-second active-lane safety sweep; publishing before commit could tick a
  // lane against rolled-back evidence.
  collectDirtyLanes(outcome.dirtyLanes ?? []);
  return true;
}

/** Terminalize only after every classification/ladder/campaign write owned by
 * this ingest pass is complete. Clearing the token earlier would let another
 * sweeper claim `failed` and overlap the still-running bookkeeping tail. */
async function finalizeOwnedFailedJob(
  db: DB,
  jobId: string,
  msg: string,
  lease: Pick<IngestLease, "jobId" | "token">,
  opts: { evidenceIngested?: boolean } = {},
): Promise<boolean> {
  const now = new Date();
  const [finished] = await db
    .update(simJobs)
    .set({
      status: "failed",
      engineState: "failed",
      error: msg,
      ...(opts.evidenceIngested ? { ingestedAt: now } : {}),
      finishedAt: now,
      ingestLeaseToken: null,
      ingestLeaseClaimedAt: null,
      ingestLeaseExpiresAt: null,
    })
    .where(ingestLeaseOwnedWhere(jobId, lease.token))
    .returning({ id: simJobs.id });
  return Boolean(finished);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isNotFound(e: unknown): boolean {
  return e instanceof EngineError && e.status === 404;
}

function queueListsJob(queue: EngineQueueState, engineJobId: string): boolean {
  return (
    queue.job_ids.includes(engineJobId) ||
    [...queue.active, ...queue.reserved, ...queue.scheduled].some(
      (task) => task.job_id === engineJobId,
    )
  );
}

function queueTaskJobIds(queue: EngineQueueState): string[] {
  return [...queue.active, ...queue.reserved, ...queue.scheduled]
    .map((task) => task.job_id)
    .filter((id): id is string => Boolean(id));
}

async function engineQueueMentionsJob(
  engine: EngineClient,
  engineJobId: string,
): Promise<boolean | null> {
  try {
    return queueListsJob(await engine.getQueue(), engineJobId);
  } catch {
    return null;
  }
}

async function engineRuntimeMap(
  engine: EngineClient,
  jobIds: string[],
): Promise<Map<string, JobRuntimeSummary>> {
  if (jobIds.length === 0 || typeof engine.getJobRuntimes !== "function")
    return new Map();
  try {
    const response = await engine.getJobRuntimes(jobIds);
    return new Map(response.jobs.map((job) => [job.job_id, job]));
  } catch {
    return new Map();
  }
}

function requestPayload(job: SimJobRow): Record<string, unknown> {
  return ((job.requestPayload ?? {}) as Record<string, unknown>) ?? {};
}

export function parsedExecutedMeshRecoveryVersion(
  value: unknown,
): number | null {
  return parsedMeshRecoveryVersion(value);
}

type EngineRequestPayloadAcknowledgement = {
  scheduling?: JobStatus["scheduling"];
  mesh_recovery_version?: unknown;
  engine?: unknown;
};

/** Build an atomic JSONB update from engine-authored metadata. Always start
 * from the row's current payload, not the poller's in-memory snapshot: two
 * status pollers may race, and an older response with an absent/malformed
 * acknowledgment must never erase a valid worker acknowledgment already
 * persisted by the newer response. */
function requestPayloadWithEngineAcknowledgementSql(
  acknowledgement: EngineRequestPayloadAcknowledgement,
) {
  let payload = sql`COALESCE(${simJobs.requestPayload}, '{}'::jsonb)`;
  if (acknowledgement.scheduling) {
    payload = sql`jsonb_set(
      ${payload},
      '{scheduling}',
      ${JSON.stringify(acknowledgement.scheduling)}::jsonb,
      true
    )`;
  }
  const version = parsedExecutedMeshRecoveryVersion(
    acknowledgement.mesh_recovery_version,
  );
  if (version != null) {
    payload = sql`jsonb_set(
      ${payload},
      '{executedMeshRecoveryVersion}',
      to_jsonb(${version}::integer),
      true
    )`;
  }
  if (isEngineRuntimeIdentity(acknowledgement.engine)) {
    payload = sql`jsonb_set(
      ${payload},
      '{executedEngine}',
      ${JSON.stringify(acknowledgement.engine)}::jsonb,
      true
    )`;
  }
  return payload;
}

/** Persist only an engine/worker-acknowledged strategy version. The SQL-side
 * jsonb merge preserves scheduling and any status acknowledgment written by a
 * newer poller. An absent/malformed result acknowledgment performs a read only,
 * so it can never erase prior provenance or fall back to the requested value. */
async function jobWithPersistedMeshRecoveryAcknowledgement(
  db: DB,
  job: SimJobRow,
  rawVersion: unknown,
  rawEngine: unknown,
  lease: Pick<IngestLease, "jobId" | "token">,
): Promise<SimJobRow> {
  await persistEngineRuntimeForJob(db, job.id, rawEngine);
  const version = parsedExecutedMeshRecoveryVersion(rawVersion);
  const runtimeEngine = isEngineRuntimeIdentity(rawEngine) ? rawEngine : null;
  let payload = sql`COALESCE(${simJobs.requestPayload}, '{}'::jsonb)`;
  if (version != null) {
    payload = sql`jsonb_set(
      ${payload},
      '{executedMeshRecoveryVersion}',
      to_jsonb(${version}::integer),
      true
    )`;
  }
  if (runtimeEngine) {
    payload = sql`jsonb_set(
      ${payload},
      '{executedEngine}',
      ${JSON.stringify(runtimeEngine)}::jsonb,
      true
    )`;
  }
  const [current] =
    version == null && runtimeEngine == null
      ? await db
          .select({ requestPayload: simJobs.requestPayload })
          .from(simJobs)
          .where(ingestLeaseOwnedWhere(job.id, lease.token))
          .limit(1)
      : await db
          .update(simJobs)
          .set({
            requestPayload: payload,
          })
          .where(ingestLeaseOwnedWhere(job.id, lease.token))
          .returning({ requestPayload: simJobs.requestPayload });
  if (!current) throw new IngestLeaseLostError(job.id);
  return { ...job, requestPayload: current.requestPayload };
}

/** Batched campaign jobs carry a requestPayload conditionMap: one
 *  (condition, revision, bc, canonical speed) entry per bundled speed. Jobs
 *  without one keep the single-revision paths untouched. Every job→revision
 *  assumption in this module goes through this helper or releases claims by
 *  simJobId (which already spans all entries of a batched job). */
function conditionMapForJob(job: SimJobRow): ConditionMapEntry[] | null {
  const raw = (requestPayload(job) as { conditionMap?: ConditionMapEntry[] })
    .conditionMap;
  return Array.isArray(raw) && raw.length > 0 ? raw : null;
}

/** URANS fidelity tier a wave-2 job requested (requestPayload.uransFidelity),
 *  the honest fallback for points whose engine fidelity echo is missing. */
function uransFidelityForJob(job: SimJobRow): UransFidelity | undefined {
  const raw = (requestPayload(job) as { uransFidelity?: unknown })
    .uransFidelity;
  return raw === "precalc" || raw === "full" ? raw : undefined;
}

/** Ladder contract 4: after the polar-cache refresh classified a job's fresh
 *  rows, every ACCEPTED urans_precalc results row in the job's revisions owes
 *  a full-fidelity verification — enqueue idempotently (partial unique index).
 *  Shared request jobs carry campaign_id=NULL, so current provenance comes
 *  from request associations plus background_owner, never requested_by (the
 *  immutable creator). Enqueue failure is an ingest
 *  failure: idempotent retry is safer than permanently losing the obligation. */
export async function enqueueVerificationsForJob(
  db: DB,
  job: SimJobRow,
): Promise<void> {
  const conditionMap = conditionMapForJob(job);
  const revisionIds = conditionMap
    ? [...new Set(conditionMap.map((entry) => entry.revisionId))]
    : job.simulationPresetRevisionId
      ? [job.simulationPresetRevisionId]
      : [];
  const payload = requestPayload(job) as {
    uransRequestId?: unknown;
    precalcObligationIds?: unknown;
    aoas?: unknown;
  };
  const aoas = Array.isArray(payload.aoas)
    ? payload.aoas.filter(
        (aoa): aoa is number => typeof aoa === "number" && Number.isFinite(aoa),
      )
    : [];
  const cells = [
    ...new Map(
      revisionIds.flatMap((revisionId) =>
        aoas.map(
          (aoaDeg) =>
            [`${revisionId}:${aoaDeg}`, { revisionId, aoaDeg }] as const,
        ),
      ),
    ).values(),
  ];
  if (!cells.length) return;

  let requestOwners: Array<string | null> | null = null;
  let fullRequestId: string | null = null;
  if (!job.campaignId && typeof payload.uransRequestId === "string") {
    const [request] = await db
      .select({
        backgroundOwner: simUransRequests.backgroundOwner,
        fidelity: simUransRequests.fidelity,
      })
      .from(simUransRequests)
      .where(eq(simUransRequests.id, payload.uransRequestId))
      .limit(1);
    if (request?.fidelity === "full") {
      fullRequestId = payload.uransRequestId;
    }
    const owners = (await db.execute(sql`
      SELECT ownership.campaign_id
      FROM sim_urans_request_campaigns ownership
      JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
      WHERE ownership.request_id = ${payload.uransRequestId}
        AND ownership.state = 'active'
        AND campaign.status IN ('active', 'attention', 'paused')
      ORDER BY ownership.campaign_id
    `)) as unknown as Array<{ campaign_id: string }>;
    requestOwners =
      request?.fidelity === "full"
        ? []
        : owners.map((owner) => owner.campaign_id);
    if (request?.fidelity !== "full" && request?.backgroundOwner)
      requestOwners.push(null);
    // A missing request row cannot prove campaign provenance; preserve the
    // pre-existing fail-safe behavior and create an independent obligation.
    if (!request) requestOwners.push(null);
  }

  const obligationIds = Array.isArray(payload.precalcObligationIds)
    ? payload.precalcObligationIds.filter(
        (id): id is string => typeof id === "string",
      )
    : [];
  const obligationOwnership = obligationIds.length
    ? ((await db.execute(sql`
        SELECT obligation.revision_id,
               obligation.aoa_deg::float8 AS aoa_deg,
               obligation.background_owner,
               COALESCE(
                 array_agg(DISTINCT campaign.id ORDER BY campaign.id)
                   FILTER (WHERE campaign.id IS NOT NULL),
                 ARRAY[]::uuid[]
               ) AS campaign_ids
        FROM sim_precalc_obligations obligation
        LEFT JOIN sim_precalc_obligation_campaigns ownership
          ON ownership.obligation_id = obligation.id
         AND ownership.state = 'active'
        LEFT JOIN sim_campaigns campaign
          ON campaign.id = ownership.campaign_id
         AND campaign.status IN ('active', 'attention', 'paused')
        WHERE obligation.id = ANY(${sql`ARRAY[${sql.join(
          obligationIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]`})
        GROUP BY obligation.id
      `)) as unknown as Array<{
        revision_id: string;
        aoa_deg: number;
        background_owner: boolean;
        campaign_ids: string[];
      }>)
    : [];
  const obligationOwnersByCell = new Map(
    obligationOwnership.map((row) => [
      `${row.revision_id}:${Number(row.aoa_deg)}`,
      [...row.campaign_ids, ...(row.background_owner ? [null] : [])] as Array<
        string | null
      >,
    ]),
  );

  for (const cell of cells) {
    if (fullRequestId) {
      try {
        const enqueued = await enqueuePrecalcVerifications(db, {
          airfoilId: job.airfoilId,
          revisionId: cell.revisionId,
          requestId: fullRequestId,
          aoaDeg: cell.aoaDeg,
        });
        if (enqueued > 0) {
          console.log(
            `[sweeper] verify queue: enqueued ${enqueued} request-owned preliminary point(s) (job ${job.id}, request ${fullRequestId}, revision ${cell.revisionId}, aoa ${cell.aoaDeg})`,
          );
        }
      } catch (e) {
        console.error(
          `[sweeper] request-owned verify enqueue FAILED (job ${job.id}, request ${fullRequestId}, revision ${cell.revisionId}, aoa ${cell.aoaDeg}): ${errorMessage(e)}`,
        );
        throw e;
      }
      continue;
    }
    const verificationOwners = job.campaignId
      ? [job.campaignId]
      : (requestOwners ??
        obligationOwnersByCell.get(`${cell.revisionId}:${cell.aoaDeg}`) ??
        (obligationIds.length ? [] : [null]));
    for (const campaignId of verificationOwners) {
      try {
        const enqueued = await enqueuePrecalcVerifications(db, {
          airfoilId: job.airfoilId,
          revisionId: cell.revisionId,
          campaignId,
          aoaDeg: cell.aoaDeg,
        });
        if (enqueued > 0) {
          console.log(
            `[sweeper] verify queue: enqueued ${enqueued} precalc-accepted point(s) (job ${job.id}, revision ${cell.revisionId}, aoa ${cell.aoaDeg})`,
          );
        }
      } catch (e) {
        console.error(
          `[sweeper] verify-queue enqueue FAILED (job ${job.id}, revision ${cell.revisionId}, aoa ${cell.aoaDeg}): ${errorMessage(e)}`,
        );
        throw e;
      }
    }
  }
}

interface VerifyJobPayload {
  verifyQueueItemId?: string;
  verifyPrecalcResultAttemptId?: string;
  verifyPrecalc?: {
    cl?: number | null;
    cd?: number | null;
    cm?: number | null;
  };
  uransRequestId?: string;
  uransFidelity?: string;
  precalcObligationIds?: string[];
  finalRecoveryMode?: "fresh" | "continuation";
  continueFromResultId?: string;
  continueFromResultAttemptId?: string;
}

const PRECALC_CONTINUATION_PERMANENT_INCIDENT_SIGNATURE =
  "precalc-continuation-permanent-v1";

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Settle fidelity-ladder bookkeeping after a job's terminal ingest:
 *  - verify jobs (payload.verifyQueueItemId): complete the queue item —
 *    record deltas vs the precalc snapshot captured at consume time, mark
 *    done, or DISAGREED when |ΔCl| > 0.05 or |ΔCd| > 0.01 (contract 4). The
 *    classification stays on the VERIFIED row (it IS the results row now);
 *    the machine disagreement is surfaced by the queue state and deltas
 *    without mutating immutable solver-attempt warnings. A failed verify solve
 *    enters bounded automatic recovery or becomes critically blocked (the
 *    failure evidence remains in attempt history).
 *  - full admin requests are aggregate projections of their preliminary and
 *    final per-point children; no job flips the aggregate directly to done. */
async function settleUransLadderForJob(
  db: DB,
  job: SimJobRow,
  opts: {
    terminalError?: string | null;
    terminalFailureDisposition?: JobResult["failure_disposition"];
    terminalContinuationFailureKind?: JobResult["continuation_failure_kind"];
  } = {},
): Promise<void> {
  const payload = requestPayload(job) as VerifyJobPayload;
  const precalcSettlement = await settlePrecalcObligationsForJob(db, job, {
    terminalError: opts.terminalError ?? null,
    terminalFailureDisposition: opts.terminalFailureDisposition ?? null,
    terminalContinuationFailureKind:
      opts.terminalContinuationFailureKind ?? null,
  });
  if (precalcSettlement.blocked.length) {
    const continuationIncident =
      precalcSettlement.continuationPermanent.length > 0
        ? `; ${precalcSettlement.continuationPermanent.length} permanent continuation source incident(s); incident_signature=${PRECALC_CONTINUATION_PERMANENT_INCIDENT_SIGNATURE}`
        : "";
    console.error(
      `[sweeper] PRECALC OBLIGATION BLOCKED (job ${job.id}): ${precalcSettlement.blocked.length} physical cell(s) exhausted, deterministic, or permanently unrestorable; canonical evidence retained and no human review assigned${continuationIncident}`,
    );
  }
  if (payload.uransRequestId) {
    await refreshFullUransRequestState(db, payload.uransRequestId);
  }
  if (!payload.verifyQueueItemId) return;
  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const [item] = await tx
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.id, payload.verifyQueueItemId!))
      .for("update")
      .limit(1);
    if (!item || item.state !== "running" || item.simJobId !== job.id) {
      console.error(
        `[sweeper] stale URANS verify settlement ignored (item ${payload.verifyQueueItemId}, job ${job.id}); exact owner: ${item?.simJobId ?? "none"}`,
      );
      return;
    }

    const [precalc] = item.precalcResultAttemptId
      ? await tx
          .select({
            resultAttemptId: resultAttempts.id,
            bcId: resultAttempts.bcId,
            cl: resultAttempts.cl,
            cd: resultAttempts.cd,
            cm: resultAttempts.cm,
          })
          .from(resultAttempts)
          .where(
            and(
              eq(resultAttempts.id, item.precalcResultAttemptId),
              eq(resultAttempts.resultId, item.precalcResultId),
              eq(resultAttempts.airfoilId, item.airfoilId),
              eq(resultAttempts.simulationPresetRevisionId, item.revisionId),
              eq(resultAttempts.aoaDeg, item.aoaDeg),
              eq(resultAttempts.status, "done"),
              eq(resultAttempts.source, "solved"),
              sql`${resultAttempts.evidencePayload} ->> 'fidelity' = 'urans_precalc'`,
            ),
          )
          .limit(1)
      : [];
    if (!precalc) {
      throw new Error(
        `verify item ${item.id} lost its exact preliminary attempt ${item.precalcResultAttemptId ?? "missing"}`,
      );
    }
    if (
      payload.verifyPrecalcResultAttemptId &&
      payload.verifyPrecalcResultAttemptId !== precalc.resultAttemptId
    ) {
      throw new Error(
        `verify job ${job.id} preliminary attempt ${payload.verifyPrecalcResultAttemptId} does not match queue owner ${precalc.resultAttemptId}`,
      );
    }

    const continuationPairComplete = Boolean(
      payload.finalRecoveryMode === "continuation" &&
      typeof payload.continueFromResultId === "string" &&
      typeof payload.continueFromResultAttemptId === "string",
    );
    const continuationSourceAttemptId = continuationPairComplete
      ? payload.continueFromResultAttemptId!
      : null;
    const continuationSourceResultId = continuationPairComplete
      ? payload.continueFromResultId!
      : null;
    const [continuationSource] =
      continuationSourceAttemptId &&
      continuationSourceResultId &&
      item.latestResultAttemptId === continuationSourceAttemptId &&
      (item.lastOutcome === FINAL_URANS_OUTCOMES.continuationPending ||
        item.lastOutcome === FINAL_URANS_OUTCOMES.continuationRetryWait)
        ? await tx
            .select({
              id: resultAttempts.id,
              resultId: resultAttempts.resultId,
              airfoilId: resultAttempts.airfoilId,
              bcId: resultAttempts.bcId,
              revisionId: resultAttempts.simulationPresetRevisionId,
              aoaDeg: resultAttempts.aoaDeg,
              status: resultAttempts.status,
              source: resultAttempts.source,
              fidelity: sql<
                string | null
              >`${resultAttempts.evidencePayload} ->> 'fidelity'`,
              engineJobId: resultAttempts.engineJobId,
              engineCaseSlug: resultAttempts.engineCaseSlug,
              solverImplementationId: resultAttempts.solverImplementationId,
              targetSolverImplementationId:
                simulationPresetRevisions.solverImplementationId,
              qualityWarnings: resultAttempts.qualityWarnings,
              evidencePayload: resultAttempts.evidencePayload,
              classification: resultClassifications.state,
            })
            .from(resultAttempts)
            .innerJoin(
              simulationPresetRevisions,
              eq(
                simulationPresetRevisions.id,
                resultAttempts.simulationPresetRevisionId,
              ),
            )
            .innerJoin(
              resultClassifications,
              eq(resultClassifications.resultAttemptId, resultAttempts.id),
            )
            .where(
              and(
                eq(resultAttempts.id, continuationSourceAttemptId),
                eq(resultAttempts.resultId, continuationSourceResultId),
              ),
            )
            .limit(1)
        : [];
    const continuationSourceMatchesAuthorization = Boolean(
      continuationSource &&
      continuationSource.resultId === continuationSourceResultId &&
      continuationSource.id === item.latestResultAttemptId &&
      continuationSource.airfoilId === item.airfoilId &&
      continuationSource.airfoilId === job.airfoilId &&
      continuationSource.bcId === precalc.bcId &&
      job.bcIds.length === 1 &&
      job.bcIds[0] === continuationSource.bcId &&
      continuationSource.revisionId === item.revisionId &&
      continuationSource.revisionId === job.simulationPresetRevisionId &&
      Number(continuationSource.aoaDeg) === Number(item.aoaDeg) &&
      ["done", "failed"].includes(continuationSource.status) &&
      continuationSource.source === "solved" &&
      continuationSource.fidelity === "urans_full" &&
      continuationSource.classification === "rejected" &&
      continuationSource.engineJobId &&
      continuationSource.engineCaseSlug &&
      continuationSource.solverImplementationId &&
      continuationSource.solverImplementationId ===
        continuationSource.targetSolverImplementationId &&
      continuationSource.solverImplementationId ===
        job.solverImplementationId &&
      (continuationSource.qualityWarnings ?? []).some(
        (warning) =>
          warning.includes(URANS_BUDGET_STOP_MARKER) ||
          warning.includes(URANS_CONTINUATION_REQUIRED_MARKER),
      ),
    );
    const isContinuation = Boolean(
      continuationSourceMatchesAuthorization &&
      continuationSourceResultId &&
      continuationSourceAttemptId &&
      (await hasExactValidSolverManifest(
        tx,
        continuationSourceResultId,
        continuationSourceAttemptId,
      )) &&
      (await hasExactVerifiedRestartableEvidenceArchive(
        tx,
        continuationSourceResultId,
        continuationSourceAttemptId,
      )),
    );
    if (payload.finalRecoveryMode === "continuation" && !isContinuation) {
      console.error(
        `[sweeper] final continuation trust check rejected for verify item ${item.id}, job ${job.id}; exact current result/attempt, cell, boundary condition, solver implementation, manifest, and restart archive are required. This physical run is accounted as fresh.`,
      );
    }

    const [verified] = await tx
      .select({
        resultId: resultAttempts.resultId,
        attemptId: resultAttempts.id,
        attemptSimJobId: resultAttempts.simJobId,
        status: resultAttempts.status,
        source: resultAttempts.source,
        fidelity: sql<
          string | null
        >`${resultAttempts.evidencePayload} ->> 'fidelity'`,
        cl: resultAttempts.cl,
        cd: resultAttempts.cd,
        cm: resultAttempts.cm,
        engineJobId: resultAttempts.engineJobId,
        engineCaseSlug: resultAttempts.engineCaseSlug,
        solverImplementationId: resultAttempts.solverImplementationId,
        error: resultAttempts.error,
        qualityWarnings: resultAttempts.qualityWarnings,
        evidencePayload: resultAttempts.evidencePayload,
        failureDisposition: sql<
          string | null
        >`${resultAttempts.evidencePayload} ->> 'failure_disposition'`,
        classification: resultClassifications.state,
        classificationReasons: resultClassifications.reasons,
      })
      .from(resultAttempts)
      .leftJoin(
        resultClassifications,
        eq(resultClassifications.resultAttemptId, resultAttempts.id),
      )
      .where(
        and(
          eq(resultAttempts.simJobId, job.id),
          eq(resultAttempts.airfoilId, item.airfoilId),
          eq(resultAttempts.simulationPresetRevisionId, item.revisionId),
          eq(resultAttempts.aoaDeg, item.aoaDeg),
          sql`${resultAttempts.evidencePayload} ->> 'fidelity' = 'urans_full'`,
        ),
      )
      .orderBy(desc(resultAttempts.createdAt), desc(resultAttempts.id))
      .limit(1);
    // The exact immutable attempt is the judge even when the replace guard
    // correctly leaves the accepted preliminary generation selected. Another
    // generation at the same cell can never stand in for this job.
    const verifiedSolved = Boolean(
      verified &&
      verified.attemptSimJobId === job.id &&
      verified.status === "done" &&
      verified.source === "solved" &&
      verified.fidelity === "urans_full" &&
      verified.classification === "accepted" &&
      verified.resultId,
    );
    const deltaOf = (a: unknown, b: number | null): number | null => {
      const pa = finiteOrNull(a);
      return pa !== null && b !== null ? b - pa : null;
    };
    if (verifiedSolved && verified?.resultId) {
      const deltaCl = deltaOf(precalc.cl, finiteOrNull(verified.cl));
      const deltaCd = deltaOf(precalc.cd, finiteOrNull(verified.cd));
      const deltaCm = deltaOf(precalc.cm, finiteOrNull(verified.cm));
      const disagreed =
        (deltaCl !== null && Math.abs(deltaCl) > URANS_VERIFY_DELTA_CL_LIMIT) ||
        (deltaCd !== null && Math.abs(deltaCd) > URANS_VERIFY_DELTA_CD_LIMIT);
      await tx
        .update(simUransVerifyQueue)
        .set({
          state: disagreed ? "disagreed" : "done",
          simJobId: job.id,
          verifyResultId: verified.resultId,
          deltaCl,
          deltaCd,
          deltaCm,
          freshAttemptCount: item.freshAttemptCount + (isContinuation ? 0 : 1),
          continuationAttemptCount:
            item.continuationAttemptCount + (isContinuation ? 1 : 0),
          continuationNoProgressCount: 0,
          latestResultAttemptId: verified.attemptId,
          nextSubmitAt: null,
          lastOutcome: disagreed
            ? FINAL_URANS_OUTCOMES.disagreed
            : FINAL_URANS_OUTCOMES.accepted,
          lastError: null,
        })
        .where(
          and(
            eq(simUransVerifyQueue.id, item.id),
            eq(simUransVerifyQueue.state, "running"),
            eq(simUransVerifyQueue.simJobId, job.id),
          ),
        );
      await resolveSolverIncidentsForOwnerInTransaction(tx, {
        verifyQueueId: item.id,
      });
      await refreshFullUransRequestsForVerifyQueueInTransaction(tx, item.id);
      if (disagreed) {
        console.warn(
          `[sweeper] urans-verify-disagreement: full-fidelity verification differs from precalc beyond bounds ` +
            `(ΔCl=${deltaCl?.toFixed(4) ?? "n/a"}, ΔCd=${deltaCd?.toFixed(5) ?? "n/a"}; limits ${URANS_VERIFY_DELTA_CL_LIMIT}/${URANS_VERIFY_DELTA_CD_LIMIT}) — accepted final result retained with a comparison warning on queue item ${item.id}, selected attempt ${verified.attemptId}`,
        );
      }
      return;
    }

    const [owner] = (await tx.execute(sql`
      SELECT (
        q.background_owner
        OR EXISTS (
          SELECT 1
          FROM sim_urans_verify_queue_campaigns ownership
          JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
          WHERE ownership.queue_id = q.id
            AND ownership.state = 'active'
            AND campaign.status IN ('active', 'attention', 'paused')
        )
        OR EXISTS (
          SELECT 1
          FROM sim_urans_verify_queue_requests coverage
          JOIN sim_urans_requests request ON request.id = coverage.request_id
          WHERE coverage.queue_id = q.id
            AND request.fidelity = 'full'
            AND request.state IN ('pending', 'running')
            AND (
              request.background_owner
              OR EXISTS (
                SELECT 1
                FROM sim_urans_request_campaigns request_ownership
                JOIN sim_campaigns campaign
                  ON campaign.id = request_ownership.campaign_id
                WHERE request_ownership.request_id = request.id
                  AND request_ownership.state = 'active'
                  AND campaign.status IN ('active', 'attention', 'paused')
              )
            )
        )
      ) AS live
      FROM sim_urans_verify_queue q
      WHERE q.id = ${item.id}
    `)) as unknown as Array<{ live: boolean }>;
    const continuationFailureKind = isContinuation
      ? (opts.terminalContinuationFailureKind ?? null)
      : null;
    const failureDisposition =
      verified?.failureDisposition ?? opts.terminalFailureDisposition ?? null;
    const infrastructure =
      continuationFailureKind === "transient" ||
      failureDisposition === "infrastructure";
    const deterministic = failureDisposition === "deterministic_mesh";
    const consumesRecoveryAttempt = Boolean(
      !infrastructure &&
      !deterministic &&
      (verified || job.submittedAt || job.engineJobId),
    );
    const freshAttemptCount =
      item.freshAttemptCount +
      (!isContinuation && consumesRecoveryAttempt ? 1 : 0);
    const continuationAttemptCount =
      item.continuationAttemptCount +
      (isContinuation && consumesRecoveryAttempt ? 1 : 0);
    const continuationSourceProgress = isContinuation
      ? precalcContinuationProgressFromEvidence(
          continuationSource!.evidencePayload,
        )
      : null;
    const continuationProgressed = Boolean(
      isContinuation &&
      consumesRecoveryAttempt &&
      verified &&
      precalcContinuationMadeProgress(
        continuationSourceProgress,
        precalcContinuationProgressFromEvidence(verified?.evidencePayload),
      ),
    );
    let continuationNoProgressCount = isContinuation
      ? consumesRecoveryAttempt && verified
        ? continuationProgressed
          ? 0
          : item.continuationNoProgressCount + 1
        : item.continuationNoProgressCount
      : 0;
    const restartable = Boolean(
      verified?.engineJobId &&
      verified.engineCaseSlug &&
      (verified.qualityWarnings ?? []).some(
        (warning) =>
          warning.includes(URANS_BUDGET_STOP_MARKER) ||
          warning.includes(URANS_CONTINUATION_REQUIRED_MARKER),
      ),
    );
    const mediaOnly =
      verified?.classification === "rejected" &&
      verified.classificationReasons?.length === 1 &&
      verified.classificationReasons[0] === MISSING_URANS_VIDEO_REASON;
    const lastError =
      verified?.error?.trim() ||
      verified?.classificationReasons?.join(", ") ||
      opts.terminalError?.trim() ||
      "full URANS completed without publishable evidence";
    const continuationNoProgressExhausted = Boolean(
      isContinuation &&
      consumesRecoveryAttempt &&
      restartable &&
      !continuationProgressed &&
      continuationNoProgressCount >= FINAL_URANS_MAX_NO_PROGRESS_SEGMENTS,
    );
    const observedContinuationNoProgressCount = continuationNoProgressCount;

    let state: "pending" | "blocked" | "cancelled";
    let lastOutcome: string;
    let nextSubmitAt: Date | null = null;
    if (!owner?.live) {
      state = "cancelled";
      lastOutcome = FINAL_URANS_OUTCOMES.ownerless;
    } else if (mediaOnly && verified) {
      state = "pending";
      lastOutcome = FINAL_URANS_OUTCOMES.mediaRepairPending;
    } else if (infrastructure) {
      state = "pending";
      lastOutcome = isContinuation
        ? FINAL_URANS_OUTCOMES.continuationRetryWait
        : FINAL_URANS_OUTCOMES.infrastructureRetryWait;
      nextSubmitAt = new Date(Date.now() + FINAL_URANS_RETRY_BACKOFF_MS);
    } else if (deterministic) {
      state = "blocked";
      lastOutcome = FINAL_URANS_OUTCOMES.deterministicFailure;
    } else if (continuationFailureKind === "permanent") {
      // The exact saved trajectory is part of final-result provenance. A
      // permanently missing source is therefore a critical evidence-loss
      // incident, not permission to silently substitute a fresh trajectory.
      state = "blocked";
      lastOutcome = FINAL_URANS_OUTCOMES.continuationPermanentFailure;
    } else if (restartable && !continuationNoProgressExhausted) {
      state = "pending";
      lastOutcome = FINAL_URANS_OUTCOMES.continuationPending;
    } else if (
      continuationNoProgressExhausted &&
      freshAttemptCount < item.maxFreshAttempts
    ) {
      // The saved trajectory stopped advancing twice. Spend the one bounded
      // corrective fresh start instead of looping that immutable checkpoint;
      // its first completed result becomes the new monotonic baseline.
      state = "pending";
      lastOutcome = FINAL_URANS_OUTCOMES.freshRetryPending;
      continuationNoProgressCount = 0;
    } else if (freshAttemptCount < item.maxFreshAttempts) {
      state = "pending";
      lastOutcome = FINAL_URANS_OUTCOMES.freshRetryPending;
      continuationNoProgressCount = 0;
    } else {
      state = "blocked";
      lastOutcome = FINAL_URANS_OUTCOMES.recoveryExhausted;
    }

    await tx
      .update(simUransVerifyQueue)
      .set({
        state,
        simJobId: state === "pending" ? null : job.id,
        verifyResultId: null,
        freshAttemptCount,
        continuationAttemptCount,
        continuationNoProgressCount,
        latestResultAttemptId:
          verified?.attemptId ?? item.latestResultAttemptId,
        nextSubmitAt,
        lastOutcome,
        lastError,
      })
      .where(
        and(
          eq(simUransVerifyQueue.id, item.id),
          eq(simUransVerifyQueue.state, "running"),
          eq(simUransVerifyQueue.simJobId, job.id),
        ),
      );
    if (owner?.live && state !== "cancelled") {
      let solverImplementationId =
        verified?.solverImplementationId ?? job.solverImplementationId;
      if (!solverImplementationId) {
        const [revision] = await tx
          .select({
            solverImplementationId:
              simulationPresetRevisions.solverImplementationId,
          })
          .from(simulationPresetRevisions)
          .where(eq(simulationPresetRevisions.id, item.revisionId))
          .limit(1);
        solverImplementationId = revision?.solverImplementationId ?? null;
      }
      if (!solverImplementationId) {
        throw new Error(
          `final verify item ${item.id} has no solver implementation for incident attribution`,
        );
      }
      const reason = continuationNoProgressExhausted
        ? "continuation-no-progress"
        : solverIncidentReason(
            verified?.classificationReasons,
            continuationFailureKind === "permanent"
              ? "continuation-source-unavailable"
              : failureDisposition && failureDisposition !== "none"
                ? failureDisposition
                : mediaOnly
                  ? MISSING_URANS_VIDEO_REASON
                  : "non-publishable-evidence",
          );
      await recordSolverIncidentInTransaction(tx, {
        stage: "final",
        reason,
        severity: state === "blocked" ? "critical" : "warning",
        owner: { verifyQueueId: item.id },
        solverImplementationId,
        occurrenceKey: `final:${item.id}:${verified?.attemptId ?? job.id}:${lastOutcome}`,
        remediationVersion: URANS_RECOVERY_REMEDIATION_VERSION,
        simJobId: job.id,
        resultAttemptId: verified?.attemptId ?? null,
        metadata: {
          lastOutcome,
          classificationReasons: verified?.classificationReasons ?? [],
          failureDisposition,
          continuationFailureKind,
          freshAttemptCount,
          maxFreshAttempts: item.maxFreshAttempts,
          continuationAttemptCount,
          continuationProgressed,
          continuationNoProgressCount: observedContinuationNoProgressCount,
        },
      });
    }
    await refreshFullUransRequestsForVerifyQueueInTransaction(tx, item.id);
    if (state === "blocked") {
      console.error(
        `[sweeper] FINAL URANS CRITICAL (item ${item.id}, job ${job.id}, aoa ${item.aoaDeg}): ${lastOutcome}; ${lastError}. Accepted preliminary evidence remains selected.`,
      );
    } else if (state === "pending") {
      console.log(
        `[sweeper] final URANS recovery queued (item ${item.id}, job ${job.id}, aoa ${item.aoaDeg}): ${lastOutcome}; fresh ${freshAttemptCount}/${item.maxFreshAttempts}, continuation ${continuationAttemptCount}, no-progress ${continuationNoProgressCount}/${FINAL_URANS_MAX_NO_PROGRESS_SEGMENTS}`,
      );
    }
  });
}

/** Refresh polar-fit caches for every revision a job touched: each
 *  conditionMap entry's revision for batched campaign jobs, the job's single
 *  revision otherwise (today's path, unchanged). */
async function refreshPolarCachesForJob(
  db: DB,
  job: SimJobRow,
  heartbeat: () => Promise<void> = () => touchHeartbeat(db),
): Promise<void> {
  const conditionMap = conditionMapForJob(job);
  if (conditionMap) {
    for (const revisionId of new Set(
      conditionMap.map((entry) => entry.revisionId),
    )) {
      // Invariant: no code path may run >30 s without a heartbeat touch —
      // each revision refresh re-fits + re-classifies a whole lane and a
      // batched campaign job can span many revisions.
      await heartbeat();
      await refreshPolarCacheForRevision(db, job.airfoilId, revisionId);
    }
    return;
  }
  if (job.simulationPresetRevisionId) {
    await heartbeat();
    await refreshPolarCacheForRevision(
      db,
      job.airfoilId,
      job.simulationPresetRevisionId,
    );
  }
}

async function setupSnapshotForJob(
  db: DB,
  job: SimJobRow,
): Promise<{ snapshot: SimulationSetupSnapshot; revisionId: string } | null> {
  const payload = requestPayload(job);
  if (
    payload.setupSnapshot &&
    typeof payload.setupSnapshot === "object" &&
    job.simulationPresetRevisionId
  ) {
    return {
      snapshot: payload.setupSnapshot as SimulationSetupSnapshot,
      revisionId: job.simulationPresetRevisionId,
    };
  }
  if (!job.simulationPresetRevisionId) return null;
  const [revision] = await db
    .select()
    .from(simulationPresetRevisions)
    .where(eq(simulationPresetRevisions.id, job.simulationPresetRevisionId))
    .limit(1);
  if (!revision) return null;
  return {
    snapshot: revision.snapshot as unknown as SimulationSetupSnapshot,
    revisionId: revision.id,
  };
}

/** Engine-side cancellation (G2, incident 2026-07-05): a job the ENGINE
 *  reports as `cancelled` is terminal — mark the sim_job cancelled and release
 *  its claimed results rows back to `pending` so the gap finders
 *  (findGaps/findCampaignGapBatch) re-claim the points on the next tick. This
 *  is the exact claim-release the node-side admin cancel route performs
 *  (apps/api/src/admin-routes.ts POST /api/admin/jobs/:id/cancel); before this
 *  helper existed, engine state `cancelled` fell through the status mapping to
 *  "running" and the sweeper polled the dead job forever. Never ingests
 *  coefficients — released rows stay coefficient-free until re-solved. */
async function cancelJobAndReleaseClaims(
  db: DB,
  job: SimJobRow,
  msg: string,
  lease?: Pick<IngestLease, "jobId" | "token">,
  acknowledgement?: EngineRequestPayloadAcknowledgement,
): Promise<boolean> {
  const settlement = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const [stopped] = await tx
      .update(simJobs)
      .set({
        status: "cancelled",
        engineState: "cancelled",
        error: msg,
        finishedAt: new Date(),
        ...(acknowledgement
          ? {
              requestPayload:
                requestPayloadWithEngineAcknowledgementSql(acknowledgement),
            }
          : {}),
        ingestLeaseToken: null,
        ingestLeaseClaimedAt: null,
        ingestLeaseExpiresAt: null,
      })
      .where(
        lease
          ? ingestLeaseOwnedWhere(job.id, lease.token)
          : reconcilableJobWhere(job.id),
      )
      .returning({ id: simJobs.id, requestPayload: simJobs.requestPayload });
    if (!stopped) return null;
    await releaseResultClaimsForJob(tx, job.id, ["queued", "running"]);
    return settlePrecalcObligationsForJobInTransaction(
      tx,
      { ...job, requestPayload: stopped.requestPayload },
      {
        terminalError: msg,
        cancellation: "transient",
      },
    );
  });
  if (!settlement) return false;
  await refreshPrecalcSettlementCampaigns(db, settlement.campaignIds);
  return true;
}

/** Zombie auto-recovery (G3, incident 2026-07-05): 4 in-flight celery tasks
 *  died with a force-recreated worker, but the engine's persisted status store
 *  kept answering state=running (HTTP 200, active_pids: [], last_progress_at
 *  hours stale), so the sweeper polled them as "running" for ~2.3 h. Detect
 *  that shape and treat it as LOST: engine says running, but
 *    - the runtime probe finds ZERO OpenFOAM processes,
 *    - the worker runtime heartbeat is stale/absent (a live celery task
 *      refreshes it even while waiting for CPU tokens),
 *    - Celery does not list the task (queue evidence required — a null queue
 *      probe never condemns a job), and
 *    - last progress is older than the grace below.
 *  Returns the loud reason string, or null when the job must be left alone. */
function classifyLostRunning(
  job: SimJobRow,
  status: JobStatus,
  runtime: JobRuntimeSummary | null,
  queue: EngineQueueState | null,
  now = Date.now(),
): string | null {
  if (status.state !== "running") return null;
  if (!runtime || !runtime.exists || runtime.process_count > 0) return null;
  const heartbeatAlive =
    runtime.runtime_heartbeat_age_sec != null &&
    Number.isFinite(Number(runtime.runtime_heartbeat_age_sec)) &&
    Number(runtime.runtime_heartbeat_age_sec) <= 120;
  if (heartbeatAlive) return null;
  if (!queue || engineQueueListsJob(queue, job.engineJobId)) return null;
  const lastProgress =
    parseEngineDate(status.last_progress_at) ??
    parseEngineDate(status.started_at) ??
    parseEngineDate(status.queued_at);
  if (!lastProgress) return null;
  const quietMs = now - lastProgress.getTime();
  if (quietMs < LOST_RUNNING_GRACE_MS) return null;
  return (
    `engine reports running but no OpenFOAM process exists, the worker heartbeat is stale, Celery does not list the task, ` +
    // Honest cause set: this shape now also covers the engine's celery hard
    // time-limit kill (task_time_limit, 2026-07-07), where the pool child is
    // SIGKILLed without any worker restart — so the message must not assert a
    // restart it cannot prove.
    `and last progress was ${Math.round(quietMs / 60000)} min ago — task lost (worker process died, was hard-killed, or restarted mid-solve); cancelled and requeued`
  );
}

/** Grace before declaring an engine-"running" job lost. The engine bumps
 *  status last_progress_at ONLY when completed_cases increases or the job goes
 *  terminal (src/airfoilfoam/storage.py write_status), so a single long case
 *  (meshing + a URANS march can legitimately run 20+ min) shows no progress
 *  while perfectly healthy. 30 min comfortably exceeds those quiet gaps, and
 *  process liveness is the primary signal anyway: the lost path additionally
 *  requires process_count == 0, a stale worker heartbeat, and absence from
 *  Celery — a healthy quiet case fails all three of those guards. */
const LOST_RUNNING_GRACE_MS = Number(
  process.env.SWEEPER_LOST_RUNNING_GRACE_MS ?? 30 * 60 * 1000,
);

function parseEngineDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function updateJobFromEngineStatus(
  db: DB,
  job: SimJobRow,
  status: JobStatus,
): Promise<void> {
  await persistEngineRuntimeForJob(db, job.id, status.engine);
  if (status.state === "cancelled") {
    // G2 dispatch site 1 (status mapping): `cancelled` used to fall through
    // the ternary below to status "running".
    await cancelJobAndReleaseClaims(
      db,
      job,
      status.message ?? "engine reported job cancelled; claims released",
      undefined,
      status,
    );
    return;
  }
  await db
    .update(simJobs)
    .set({
      engineState: status.state,
      completedCases: status.completed_cases,
      totalCases: status.total_cases,
      polledAt: new Date(),
      error: status.state === "failed" ? (status.message ?? job.error) : null,
      finishedAt: null,
      requestPayload: requestPayloadWithEngineAcknowledgementSql(status),
      // Terminal engine state does NOT pre-claim DB ingestion. Completed
      // evidence stays on the submitted/running side until the atomic lease
      // claim wins; failed is itself a claimable recovery source. Writing a
      // tokenless `ingesting` row here stranded work for the legacy grace and
      // let stale pollers overwrite a real owner.
      status:
        status.state === "failed"
          ? "failed"
          : status.state === "pending"
            ? "submitted"
            : "running",
      ingestLeaseToken: null,
      ingestLeaseClaimedAt: null,
      ingestLeaseExpiresAt: null,
    })
    .where(reconcilableJobWhere(job.id));
}

async function markIngestRetry(
  db: DB,
  jobId: string,
  e: unknown,
  lease?: Pick<IngestLease, "jobId" | "token">,
): Promise<void> {
  const now = new Date();
  await db
    .update(simJobs)
    .set({
      status: "ingesting",
      engineState: "completed",
      error: "ingest retry pending: " + errorMessage(e),
      polledAt: now,
      finishedAt: null,
      ingestLeaseToken: null,
      ingestLeaseClaimedAt: null,
      // An explicit expired timestamp makes the row immediately reclaimable;
      // it does not wait for the legacy null-lease grace window.
      ingestLeaseExpiresAt: now,
    })
    .where(
      lease
        ? ingestLeaseOwnedWhere(jobId, lease.token)
        : and(
            reconcilableJobWhere(jobId),
            or(
              sql`${simJobs.status} <> 'ingesting'`,
              lte(simJobs.ingestLeaseExpiresAt, now),
              and(
                isNull(simJobs.ingestLeaseExpiresAt),
                lte(
                  simJobs.updatedAt,
                  new Date(now.getTime() - DEFAULT_INGEST_LEASE_MS),
                ),
              ),
            ),
          ),
    );
}

async function requeueLostJob(
  db: DB,
  job: SimJobRow,
  msg: string,
): Promise<void> {
  const settlement = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const [stopped] = await tx
      .update(simJobs)
      .set({
        status: "cancelled",
        engineState: "missing",
        error: msg,
        finishedAt: new Date(),
        ingestLeaseToken: null,
        ingestLeaseClaimedAt: null,
        ingestLeaseExpiresAt: null,
      })
      .where(reconcilableJobWhere(job.id))
      .returning({ id: simJobs.id });
    if (!stopped) return null;
    await releaseResultClaimsForJob(tx, job.id, [
      "queued",
      "running",
      "pending",
      "stale",
      "failed",
    ]);
    return settlePrecalcObligationsForJobInTransaction(tx, job, {
      terminalError: msg,
      cancellation: "transient",
    });
  });
  if (settlement)
    await refreshPrecalcSettlementCampaigns(db, settlement.campaignIds);
}

async function markPollMiss(
  db: DB,
  job: SimJobRow,
  msg: string,
): Promise<void> {
  await db
    .update(simJobs)
    .set({
      status: "running",
      engineState: "missing",
      error: msg,
      polledAt: new Date(),
      finishedAt: null,
      ingestLeaseToken: null,
      ingestLeaseClaimedAt: null,
      ingestLeaseExpiresAt: null,
    })
    .where(activeJobWhere(job.id));
}

/** Remove cells that already have terminal preliminary coverage or another
 * active preliminary owner from a TARGETED composition plan. This function
 * must never trim a whole-polar promotion event: its immutable coverage is the
 * original pinned request, while schedulability is decided from obligations
 * only after that full event is durable. */
async function withoutExistingPrecalcCoverage(
  db: DB,
  opts: {
    parentJobId: string;
    airfoilId: string;
    revisionId: string;
    retry: RansRetryDecision;
    meshRecoveryVersion: number;
  },
): Promise<RansRetryDecision | null> {
  if (!opts.retry.aoas.length) return null;
  const rows = (await db.execute(sql`
    SELECT blocked.aoa_deg::float8 AS aoa_deg
    FROM (
      SELECT DISTINCT evidence.aoa_deg
      FROM sim_jobs child
      CROSS JOIN LATERAL (
        SELECT attempt.aoa_deg,
               attempt.error,
               attempt.evidence_payload ->> 'failure_disposition' AS failure_disposition
        FROM result_attempts attempt
        WHERE attempt.sim_job_id = child.id
        UNION ALL
        SELECT canonical.aoa_deg,
               canonical.error,
               current_attempt.evidence_payload ->> 'failure_disposition' AS failure_disposition
        FROM results canonical
        LEFT JOIN result_attempts current_attempt
          ON current_attempt.id = canonical.current_result_attempt_id
         AND current_attempt.result_id = canonical.id
        WHERE canonical.sim_job_id = child.id
      ) evidence
      WHERE child.parent_job_id = ${opts.parentJobId}
        AND child.wave = 2
        AND child.status IN ('done', 'failed', 'cancelled')
        AND child.simulation_preset_revision_id = ${opts.revisionId}
        AND child.request_payload ->> 'uransFidelity' = 'precalc'
        AND CASE
          WHEN jsonb_typeof(child.request_payload -> 'executedMeshRecoveryVersion') = 'number'
           AND child.request_payload ->> 'executedMeshRecoveryVersion' ~ '^[0-9]+$'
          THEN CASE
            WHEN (child.request_payload ->> 'executedMeshRecoveryVersion')::numeric <= 2147483647
            THEN (child.request_payload ->> 'executedMeshRecoveryVersion')::numeric::bigint
            ELSE 0::bigint
          END
          ELSE 0::bigint
        END >= ${opts.meshRecoveryVersion}
        AND ${deterministicMeshEvidenceSql(
          sql`evidence.failure_disposition`,
          sql`evidence.error`,
        )}
      UNION
      SELECT obligation.aoa_deg
      FROM sim_precalc_obligations obligation
      WHERE obligation.airfoil_id = ${opts.airfoilId}
        AND obligation.revision_id = ${opts.revisionId}
        AND obligation.state IN ('blocked', 'satisfied', 'cancelled')
      UNION
      SELECT request_item.aoa_deg
      FROM sim_urans_requests request_item
      WHERE request_item.airfoil_id = ${opts.airfoilId}
        AND request_item.revision_id = ${opts.revisionId}
        AND request_item.fidelity = 'precalc'
        AND request_item.aoa_deg IS NOT NULL
        AND request_item.state IN ('pending', 'running')
    ) blocked
    WHERE blocked.aoa_deg = ANY(${sql`ARRAY[${sql.join(
      opts.retry.aoas.map((aoa) => sql`${aoa}::float8`),
      sql`, `,
    )}]`})
  `)) as unknown as Array<{ aoa_deg: number }>;
  const blocked = new Set(rows.map((row) => Number(row.aoa_deg)));
  if (!blocked.size) return opts.retry;
  const aoas = opts.retry.aoas.filter((aoa) => !blocked.has(aoa));
  console.log(
    `[sweeper] targeted PRECALC composition skips already covered/owned cells (parent ${opts.parentJobId}, revision ${opts.revisionId}, angles [${[...blocked].sort((a, b) => a - b).join(", ")}])`,
  );
  if (!aoas.length) return null;
  return {
    ...opts.retry,
    aoas,
    queueCanonicalAoas: opts.retry.queueCanonicalAoas.filter(
      (aoa) => !blocked.has(aoa),
    ),
  };
}

interface Wave2CompositionSpec {
  parentJobId: string;
  revisionId: string;
  conditionId?: string;
  job: typeof simJobs.$inferInsert;
  obligationIds: string[];
}

/** Atomically compose one physical wave-2 child.
 *
 * The parent row is the no-schema-needed mutex for all sweepers considering
 * this parent. After winning it, the transaction rechecks the exact
 * (parent, revision, condition) child identity and inserts the child while
 * every physical obligation is still runnable. Canonical results are not
 * claimed: completed RANS evidence stays immutable until accepted URANS
 * ingestion replaces it by natural key. */
async function composeWave2Child(
  db: DB,
  spec: Wave2CompositionSpec,
): Promise<{ id: string } | null> {
  return composePhysicalPrecalcJob(db, {
    obligationIds: spec.obligationIds,
    job: spec.job,
    directParent: {
      parentJobId: spec.parentJobId,
      revisionId: spec.revisionId,
      conditionId: spec.conditionId,
    },
  });
}

/** Durable ownerless row shape for a wave-2 obligation.
 *
 * - a failed precalc retry carries its one-shot marker; or
 * - a RANS result has a stored rejected/needs_urans verdict that caused the
 *   ladder escalation.
 *
 * Both must remain invisible to the wave-1 gap finder while a paused or
 * transiently-unsubmitted wave-2 child waits to be recomposed. */
/** A rejected/unreachable engine submit releases generic claims to `pending`.
 * Restore only evidence-backed wave-2 cells to their durable queued-without-
 * owner route, so the next tick cannot downgrade them to RANS. */
async function restoreUnsubmittedWave2Route(
  db: DB,
  opts: { airfoilId: string; revisionId: string; aoas: number[] },
): Promise<void> {
  await db
    .update(results)
    .set({ status: "queued", source: "queued", simJobId: null })
    .where(
      and(
        eq(results.airfoilId, opts.airfoilId),
        eq(results.simulationPresetRevisionId, opts.revisionId),
        inArray(results.aoaDeg, opts.aoas),
        eq(results.status, "pending"),
        isNull(results.simJobId),
        EVIDENCE_BACKED_WAVE2_RESULT_SQL,
      ),
    );
}

async function campaignIsPaused(
  db: DB,
  campaignId: string | null,
): Promise<boolean> {
  if (!campaignId) return false;
  const [row] = await db
    .select({ status: simCampaigns.status })
    .from(simCampaigns)
    .where(eq(simCampaigns.id, campaignId))
    .limit(1);
  return row?.status === "paused";
}

interface RemotePromiseProvenance {
  syncPromiseId: string;
  remoteSolver: true;
  upstreamBaseUrl: string;
}

/** Resolve remote ownership only from the durable local mirror. A scalar
 * campaign_id=NULL is not background ownership: remote work remains live only
 * while its exact upstream promise lease is active and unexpired. */
async function remotePromiseProvenanceForJob(
  db: DB,
  job: SimJobRow,
): Promise<RemotePromiseProvenance | null> {
  const payload = requestPayload(job) as { syncPromiseId?: unknown };
  if (typeof payload.syncPromiseId !== "string") return null;
  const [promise] = await db
    .select({
      id: syncSweepPromises.id,
      sourceBaseUrl: syncSweepPromises.sourceBaseUrl,
    })
    .from(syncSweepPromises)
    .where(
      and(
        eq(syncSweepPromises.id, payload.syncPromiseId),
        eq(syncSweepPromises.status, "active"),
        eq(syncSweepPromises.airfoilId, job.airfoilId),
        eq(
          syncSweepPromises.simulationPresetRevisionId,
          job.simulationPresetRevisionId!,
        ),
        sql`${syncSweepPromises.expiresAt} > now()`,
        sql`${syncSweepPromises.requestPayload} ->> 'remoteSolver' = 'true'`,
      ),
    )
    .limit(1);
  if (!promise?.sourceBaseUrl) return null;
  return {
    syncPromiseId: promise.id,
    remoteSolver: true,
    upstreamBaseUrl: promise.sourceBaseUrl,
  };
}

async function cancelTerminalEngineTasks(
  db: DB,
  engine: EngineClient,
  queue: EngineQueueState,
  liveEngineJobIds: Set<string>,
): Promise<void> {
  const candidateIds = [
    ...new Set(
      queueTaskJobIds(queue).filter((jobId) => !liveEngineJobIds.has(jobId)),
    ),
  ];
  if (candidateIds.length === 0) return;

  const terminalRows = await db
    .select({
      id: simJobs.id,
      engineJobId: simJobs.engineJobId,
      status: simJobs.status,
      error: simJobs.error,
    })
    .from(simJobs)
    .where(
      and(
        inArray(simJobs.engineJobId, candidateIds),
        inArray(simJobs.status, ["done", "failed", "cancelled"]),
      ),
    );

  for (const row of terminalRows) {
    if (!row.engineJobId) continue;
    // Invariant: no code path may run >30 s without a heartbeat touch — each
    // engine-side cancel is a round-trip that crawls when the worker is
    // saturated, and a restart can leave a batch of obsolete tasks.
    await touchHeartbeat(db);
    try {
      await engine.cancelJob(row.engineJobId);
      await db
        .update(simJobs)
        .set({
          engineState: "cancelled",
          error:
            row.error ??
            `obsolete engine task cancelled after DB job reached ${row.status}`,
        })
        .where(eq(simJobs.id, row.id));
    } catch (e) {
      await db
        .update(simJobs)
        .set({
          error: `obsolete engine task cancel failed: ${errorMessage(e)}`,
        })
        .where(eq(simJobs.id, row.id));
    }
  }
}

/** Retry a persisted compensating cancel by its stored engine id even when
 * the engine queue omits the task. Queue visibility is observability, not the
 * durable ownership record. */
async function retryPersistedCancellationObligations(
  db: DB,
  engine: EngineClient,
  jobIds: string[] = [],
): Promise<Set<string>> {
  const filters = [
    eq(simJobs.status, "cancelled"),
    inArray(simJobs.engineState, ["cancelling", "cancel_pending"]),
    isNotNull(simJobs.engineJobId),
  ];
  if (jobIds.length) filters.push(inArray(simJobs.id, jobIds));
  const rows = await db
    .select({
      id: simJobs.id,
      engineJobId: simJobs.engineJobId,
      error: simJobs.error,
    })
    .from(simJobs)
    .where(and(...filters))
    .limit(10);
  const settled = new Set<string>();
  for (const row of rows) {
    if (!row.engineJobId) continue;
    await touchHeartbeat(db);
    try {
      await engine.cancelJob(row.engineJobId);
      await db
        .update(simJobs)
        .set({
          engineState: "cancelled",
          error: row.error?.includes("compensating engine cancellation")
            ? row.error.replace(
                /; compensating engine cancellation failed:.*$/,
                "; compensating engine cancellation confirmed",
              )
            : row.error,
        })
        .where(
          and(
            eq(simJobs.id, row.id),
            eq(simJobs.status, "cancelled"),
            eq(simJobs.engineJobId, row.engineJobId),
          ),
        );
      settled.add(row.engineJobId);
    } catch (error) {
      await db
        .update(simJobs)
        .set({
          engineState: "cancel_pending",
          error: `${row.error ?? "compensating engine cancellation pending"}; retry failed: ${errorMessage(error)}`,
        })
        .where(
          and(
            eq(simJobs.id, row.id),
            eq(simJobs.status, "cancelled"),
            eq(simJobs.engineJobId, row.engineJobId),
          ),
        );
    }
  }
  return settled;
}

export async function submitUransRetryForJob(
  db: DB,
  engine: EngineClient,
  parent: typeof simJobs.$inferSelect,
  opts: {
    ingestLeaseToken?: string;
    ransPrecalcPromotions?: IngestedRansPrecalcPromotion[];
    /** Partial ingest persists only typed promotion events/obligations. Child
     * composition waits for terminal parent state or stale-lease recovery, so
     * sibling RANS work keeps its resource priority. */
    recordPromotionsOnly?: boolean;
    /** Persist targeted PRECALC ownership from a running partial result without
     * submitting a child outside the capacity-bounded scheduler tick. */
    recordRoutesOnly?: boolean;
    /** Live engine capability prepared by the bounded scheduler tick. */
    meshRecoveryVersion?: number;
    /** Live durable cross-job URANS recovery contract. Legacy engines may
     * still run fresh work, but cannot consume continuation recovery. */
    uransRecoveryVersion?: number | null;
    /** The capacity-bounded scheduler may admit this exact terminal-parent
     * escalation while unrelated campaign RANS gaps remain. Direct ingest
     * callers omit it and remain route-only. */
    capacityScheduledEscalation?: boolean;
    /** Exact immutable RANS attempts selected by a shared campaign-owned
     * obligation whose producing parent may belong to background work or a
     * different campaign. When present, retry planning is targeted to only
     * these attempts; it must never widen from the source job's other cells. */
    sourceResultAttemptIds?: string[];
    /** Explicit scheduler-owned CPU envelope. Remote-promise recovery uses
     * its independent configured budget even when the local scheduler is
     * intentionally disabled. */
    cpuSlots?: number;
  } = {},
): Promise<void> {
  if (parent.wave !== 1 || parent.bcIds.length === 0) return;
  const recordedPromotions = await inspectParentRansPolarPromotions(db, {
    parentJobId: parent.id,
    ...(opts.ingestLeaseToken
      ? { ingestLeaseToken: opts.ingestLeaseToken }
      : {}),
  });
  let conditionMap = conditionMapForJob(parent);
  if (recordedPromotions.length) {
    // Persisted event identities are authoritative. Mutable batch transport is
    // usable only when it still represents every recorded condition exactly;
    // otherwise fail closed and let ledger recovery own the physical work.
    if (!conditionMap) {
      const hasBatchedEvent = recordedPromotions.some(
        (event) => event.conditionId !== null,
      );
      if (hasBatchedEvent) {
        console.error(
          `[sweeper] conditional whole-polar parent ${parent.id} has ${recordedPromotions.length} persisted batched event(s) but no usable condition map; generic retry planning skipped`,
        );
      } else {
        console.log(
          `[sweeper] conditional whole-polar event ${recordedPromotions[0]!.promotionId} remains authoritative for scalar parent ${parent.id}; generic retry planning skipped`,
        );
      }
      return;
    }
    const mapHasValidIdentities = conditionMap.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        typeof entry.revisionId === "string" &&
        entry.revisionId.length > 0 &&
        typeof entry.conditionId === "string" &&
        entry.conditionId.length > 0,
    );
    const conditionKey = (revisionId: string, conditionId: string | null) =>
      `${revisionId}:${conditionId ?? "-"}`;
    const mapKeys = new Set(
      mapHasValidIdentities
        ? conditionMap.map((entry) =>
            conditionKey(entry.revisionId, entry.conditionId),
          )
        : [],
    );
    const everyEventRepresented = recordedPromotions.every((event) =>
      mapKeys.has(conditionKey(event.revisionId, event.conditionId)),
    );
    if (!mapHasValidIdentities || !everyEventRepresented) {
      console.error(
        `[sweeper] conditional whole-polar parent ${parent.id} has a missing or corrupt condition map relative to ${recordedPromotions.length} persisted event(s); generic retry planning skipped`,
      );
      return;
    }
    const recordedKeys = new Set(
      recordedPromotions.map((event) =>
        conditionKey(event.revisionId, event.conditionId),
      ),
    );
    conditionMap = conditionMap.filter(
      (entry) =>
        !recordedKeys.has(conditionKey(entry.revisionId, entry.conditionId)),
    );
    if (!conditionMap.length) return;
  } else if (!conditionMap && !parent.simulationPresetRevisionId) {
    return;
  }
  // Direct ingest never starts a child outside scheduler capacity. The
  // capacity-bounded ladder may, however, admit the exact rejected angle from
  // this terminal parent without waiting for unrelated campaign RANS cells.
  // Its caller gives every due targeted handoff priority over unrelated RANS
  // while admitting at most one physical child per scheduler tick.
  // Conditional whole-polar widening remains ledger-authorized only.
  const campaignHasRansBacklog = Boolean(
    parent.campaignId && (await campaignHasOpenRansGaps(db, parent.campaignId)),
  );
  const campaignGated =
    campaignHasRansBacklog && !opts.capacityScheduledEscalation;
  if (campaignGated) {
    console.log(
      `[sweeper] URANS submission for job ${parent.id} is route-only during ingest: campaign ${parent.campaignId} still has open RANS gaps; the capacity scheduler will admit its exact preliminary angle`,
    );
  }
  let meshRecoveryVersion = opts.meshRecoveryVersion;
  let uransRecoveryVersion = opts.uransRecoveryVersion;
  const maySubmitNow =
    !opts.recordPromotionsOnly && !opts.recordRoutesOnly && !campaignGated;
  if (meshRecoveryVersion === undefined && maySubmitNow) {
    const probed = await engineMeshRecoveryVersion(engine);
    if (probed == null) {
      console.error(
        `[sweeper] URANS routing for job ${parent.id} deferred: engine mesh-recovery capability is unavailable or malformed`,
      );
      return;
    }
    meshRecoveryVersion = probed;
  }
  if (uransRecoveryVersion === undefined && maySubmitNow) {
    uransRecoveryVersion = await engineUransRecoveryVersion(engine);
  }
  // Record-only/gated passes never cross the engine boundary. Version zero
  // preserves the legacy terminal fence until a capacity-bounded tick probes
  // and reopens an older structured blocker.
  const effectiveMeshRecoveryVersion = meshRecoveryVersion ?? 0;
  if (conditionMap) {
    // Batched campaign parent: the retry plan is computed PER conditionMap
    // entry and each retrying condition gets its own single-revision child.
    await submitCampaignUransRetries(
      db,
      engine,
      parent,
      conditionMap,
      campaignGated,
      {
        ...opts,
        meshRecoveryVersion: effectiveMeshRecoveryVersion,
        uransRecoveryVersion,
      },
    );
    return;
  }
  const revisionId = parent.simulationPresetRevisionId;
  if (!revisionId) return;
  const parentPayload = requestPayload(parent);
  const remotePromiseHint =
    typeof (parentPayload as { syncPromiseId?: unknown }).syncPromiseId ===
    "string";
  const remoteProvenance = await remotePromiseProvenanceForJob(db, parent);
  if (remotePromiseHint && !remoteProvenance) return;
  const [existing] = await db
    .select({ id: simJobs.id })
    .from(simJobs)
    .where(
      and(
        eq(simJobs.parentJobId, parent.id),
        eq(simJobs.wave, 2),
        inArray(simJobs.status, [
          "pending",
          "submitted",
          "running",
          "ingesting",
        ]),
      ),
    )
    .limit(1);
  if (existing) return;

  await refreshPolarCacheForRevision(db, parent.airfoilId, revisionId);
  // Retry scoping is exact-attempt/job-local. Only a typed hard RANS rejection
  // in 0..5° may widen a continuous request to its pinned full polar.
  const plannedRetry = await ransRetryPlanForJobScoped(db, {
    parentJobId: parent.id,
    airfoilId: parent.airfoilId,
    revisionId,
    scope: opts.sourceResultAttemptIds?.length
      ? {
          origin: "explicit-targeted",
          requestedAoas: anglesForJob(parent),
        }
      : parseRansRetryScope(
          (parentPayload as { ransRetryScope?: unknown }).ransRetryScope,
          anglesForJob(parent),
        ),
    sourceResultAttemptIds: opts.sourceResultAttemptIds,
  });
  const retry =
    plannedRetry?.retryMode === "whole-polar-urans"
      ? plannedRetry
      : plannedRetry
        ? await withoutExistingPrecalcCoverage(db, {
            parentJobId: parent.id,
            airfoilId: parent.airfoilId,
            revisionId,
            retry: plannedRetry,
            meshRecoveryVersion: effectiveMeshRecoveryVersion,
          })
        : null;
  if (!retry || retry.aoas.length === 0) return;
  const enginePromotion = opts.ransPrecalcPromotions?.find(
    (promotion) =>
      promotion.revisionId === parent.simulationPresetRevisionId &&
      promotion.conditionId == null,
  );
  if (opts.recordPromotionsOnly && !enginePromotion) return;
  if (enginePromotion && retry.retryMode !== "whole-polar-urans") {
    throw new Error(
      `engine aborted RANS for preliminary promotion but exact Node policy did not authorize whole-polar scope (job ${parent.id}, revision ${parent.simulationPresetRevisionId})`,
    );
  }
  if (retry.retryMode === "whole-polar-urans") {
    const triggerResultAttemptId =
      enginePromotion?.triggerResultAttemptId ??
      retry.wholePolarTriggerResultAttemptId;
    const triggerAoaDeg =
      enginePromotion?.triggerAoaDeg ?? retry.wholePolarTriggerAoaDeg;
    // Whole-polar work is authorized only by its normalized immutable event.
    // Without the live ingest lease we cannot create that event, so fail
    // closed instead of composing an ordinary unbound child from derived
    // classification/request state.
    if (
      !opts.ingestLeaseToken ||
      !triggerResultAttemptId ||
      triggerAoaDeg == null
    )
      return;
    const recorded = await recordRansPolarPromotion(db, {
      parentJobId: parent.id,
      ingestLeaseToken: opts.ingestLeaseToken,
      airfoilId: parent.airfoilId,
      revisionId,
      conditionId: null,
      triggerResultAttemptId,
      triggerAoaDeg,
      requestedAoas: retry.aoas,
      intentionallyOmittedAoas: enginePromotion?.intentionallyOmittedAoas ?? [],
      ownership: {
        campaignIds: parent.campaignId ? [parent.campaignId] : [],
        backgroundOwner: parent.campaignId == null && !remoteProvenance,
        syncPromiseIds: remoteProvenance
          ? [remoteProvenance.syncPromiseId]
          : [],
      },
    });
    if (!recorded) {
      throw new Error(
        `conditional whole-polar promotion failed its atomic evidence/ownership preconditions (job ${parent.id}, revision ${parent.simulationPresetRevisionId})`,
      );
    }
    // The next ladder tick composes directly from the recorded event under
    // parent lifecycle and exact-owner locks. Never fall through to the
    // ordinary retry composer, even during terminal ingest.
    return;
  }
  // Resolve every immutable input before creating a durable physical
  // obligation. A missing/deleted setup cannot leave an open ledger row with
  // no child payload for the parent scan to recover.
  const [a] = await db
    .select()
    .from(airfoils)
    .where(eq(airfoils.id, parent.airfoilId))
    .limit(1);
  const setup = await setupSnapshotForJob(db, parent);
  if (!a || !setup) return;
  const bcId =
    setup.snapshot.preset.legacyBoundaryConditionId ?? parent.bcIds[0];
  const obligations = await ensurePrecalcObligations(
    db,
    retry.aoas.map((aoaDeg) => ({
      airfoilId: parent.airfoilId,
      revisionId: parent.simulationPresetRevisionId!,
      aoaDeg,
    })),
    {
      campaignIds: parent.campaignId ? [parent.campaignId] : [],
      backgroundOwner: parent.campaignId == null && !remoteProvenance,
      syncPromiseIds: remoteProvenance ? [remoteProvenance.syncPromiseId] : [],
    },
  );
  if (opts.recordRoutesOnly) return;
  if (campaignGated) return;
  const continuations = await precalcContinuationsForObligations(
    db,
    obligations
      .filter((obligation) => obligation.state === "pending")
      .map((obligation) => obligation.id),
  );
  const continuationIds = new Set(
    continuations.map((continuation) => continuation.obligationId),
  );
  const durableRecoveryAvailable =
    supportsDurableUransRecovery(uransRecoveryVersion);
  const schedulableByAoa = new Map(
    obligations
      .filter(
        (obligation) =>
          obligation.state === "pending" &&
          (continuationIds.has(obligation.id)
            ? durableRecoveryAvailable
            : obligation.attemptCount < obligation.maxAttempts) &&
          (!obligation.nextSubmitAt ||
            new Date(obligation.nextSubmitAt).getTime() <= Date.now()),
      )
      .map((obligation) => [obligation.aoaDeg, obligation]),
  );
  let aoas = retry.aoas.filter((aoa) => schedulableByAoa.has(aoa));
  if (!aoas.length) return;
  let obligationIds = aoas.map((aoa) => schedulableByAoa.get(aoa)!.id);
  const continuation = durableRecoveryAvailable
    ? continuations.find((candidate) =>
        obligationIds.includes(candidate.obligationId),
      )
    : undefined;
  if (continuation) {
    // One engine request can resume one saved case. Remaining cells stay
    // pending and are composed on later ladder ticks.
    aoas = [continuation.aoaDeg];
    obligationIds = [continuation.obligationId];
  }
  const [capacity] = await db
    .select({ cpuSlots: sweeperState.cpuSlots })
    .from(sweeperState)
    .where(eq(sweeperState.id, 1))
    .limit(1);
  let executionPool;
  try {
    executionPool = await requireExecutionPoolForSetup(db, setup.snapshot);
  } catch (error) {
    if (!(error instanceof SolverExecutionPoolUnavailableError)) throw error;
    console.error(
      `[sweeper] URANS routing for job ${parent.id} deferred: ${error.message}`,
    );
    return;
  }
  const { request, speed } = buildPolarRequest({
    airfoil: a,
    setup: setup.snapshot,
    aoaList: aoas,
    wave: 2,
    uransFidelity: "precalc",
    cpuSlots: opts.cpuSlots ?? capacity?.cpuSlots ?? 0,
  });
  request.expected_execution_pool = executionPool.routingKey;
  request.expected_mesh_recovery_version = effectiveMeshRecoveryVersion;
  if (continuation) {
    request.expected_urans_recovery_version = uransRecoveryVersion!;
    request.continue_from = {
      engine_job_id: continuation.engineJobId,
      case_slug: continuation.engineCaseSlug,
    };
    request.budget_override_s = continuation.budgetOverrideS;
  }
  const job = await composeWave2Child(db, {
    parentJobId: parent.id,
    revisionId: setup.revisionId,
    obligationIds,
    job: {
      parentJobId: parent.id,
      airfoilId: a.id,
      bcIds: [bcId],
      simulationPresetRevisionId: setup.revisionId,
      solverImplementationId: solverImplementationIdForSetup(setup.snapshot),
      solverExecutionPoolId: executionPool.id,
      methodKey: "openfoam.urans",
      // Physical preliminary work can satisfy several campaigns. Ownership
      // lives in sim_precalc_obligation_campaigns; a scalar campaign_id would
      // let one beneficiary cancel every other owner's solve.
      campaignId: null,
      jobKind: "targeted",
      referenceChordM: setup.snapshot.referenceGeometry.referenceLengthM,
      wave: 2,
      status: "pending",
      totalCases: aoas.length,
      requestPayload: {
        ...(remoteProvenance ?? {}),
        speedMap: [
          {
            speed,
            bcId,
            presetRevisionId: setup.revisionId,
            mach: setup.snapshot.flowState.mach,
          },
        ],
        aoas,
        parentJobId: parent.id,
        precalcObligationIds: obligationIds,
        ...(continuation
          ? {
              continueFromResultId: continuation.resultId,
              continueFromResultAttemptId: continuation.resultAttemptId,
              budgetOverrideS: continuation.budgetOverrideS,
              uransRecoveryVersion,
            }
          : {}),
        uransFidelity: "precalc",
        meshRecoveryVersion: effectiveMeshRecoveryVersion,
        retryMode: retry.retryMode,
        validRansPointCount: retry.validRansPointCount,
        needsUransCount: retry.needsUransCount,
        hardRejectedCount: retry.hardRejectedCount,
        resources: request.resources,
        setupSnapshot: setup.snapshot,
      },
    },
  });
  // Another sweeper may have composed the exact child while this caller was
  // building its request. The parent-locked transaction above is the final
  // authority; only its winner may call the external engine.
  if (!job) return;

  const submit = await submitPendingJobWithLifecycleGuard({
    db,
    engine,
    jobId: job.id,
    campaignId: null,
    request,
    connectionErrorPrefix: "engine unreachable at URANS submit: ",
    submitErrorPrefix: "URANS submit failed: ",
    precalcObligationIds: obligationIds,
  });
  if (submit.kind === "submitted") {
    await recordPrecalcObligationSubmission(db, job.id, obligationIds);
    console.log(
      `[sweeper] URANS retry submitted → engine ${submit.status.job_id} (sim_job ${job.id}, parent ${parent.id}, campaign ${parent.campaignId ?? "-"}, airfoil ${parent.airfoilId}, precalc, angles [${aoas.join(", ")}])`,
    );
    return;
  }
  if (submit.kind === "submission_in_progress") return;
  if (
    submit.kind !== "lifecycle_stopped" ||
    (await campaignIsPaused(db, parent.campaignId))
  ) {
    await restoreUnsubmittedWave2Route(db, {
      airfoilId: a.id,
      revisionId: setup.revisionId,
      aoas,
    });
  }
  if (submit.kind === "capability_mismatch") {
    console.warn(
      `[sweeper] PRECALC submit deferred by engine capability cutover (sim_job ${job.id}, parent ${parent.id}); capability will be re-probed next tick`,
    );
    return;
  }
  if (submit.kind === "connection_failure") {
    await recordEngineUnreachable(db);
    return;
  }
  if (submit.kind === "lifecycle_stopped") {
    console.log(
      `[sweeper] URANS retry stopped by campaign lifecycle (sim_job ${job.id}, parent ${parent.id}, campaign ${parent.campaignId ?? "-"}): ${submit.error}` +
        (submit.engineCancelError
          ? `; compensating cancel pending: ${submit.engineCancelError}`
          : ""),
    );
    return;
  }
  console.error(
    `[sweeper] URANS retry submit failed (sim_job ${job.id}, parent ${parent.id}): ${submit.error}`,
  );
}

/** RANS→URANS wave-2 for batched campaign parents: retry plans are computed
 *  per conditionMap entry against that entry's exact job-local attempt evidence
 *  and pinned full-polar scope, and each retrying condition
 *  submits its own single-revision child job through the existing machinery.
 *  Children are deduped per (parent, conditionId). */
async function submitCampaignUransRetries(
  db: DB,
  engine: EngineClient,
  parent: SimJobRow,
  conditionMap: ConditionMapEntry[],
  campaignGated: boolean,
  opts: {
    ingestLeaseToken?: string;
    ransPrecalcPromotions?: IngestedRansPrecalcPromotion[];
    recordPromotionsOnly?: boolean;
    recordRoutesOnly?: boolean;
    meshRecoveryVersion?: number;
    uransRecoveryVersion?: number | null;
    sourceResultAttemptIds?: string[];
  },
): Promise<void> {
  const parentPayload = requestPayload(parent);
  const remotePromiseHint =
    typeof (parentPayload as { syncPromiseId?: unknown }).syncPromiseId ===
    "string";
  const remoteProvenance = await remotePromiseProvenanceForJob(db, parent);
  if (remotePromiseHint && !remoteProvenance) return;
  const children = await db
    .select({ id: simJobs.id, requestPayload: simJobs.requestPayload })
    .from(simJobs)
    .where(
      and(
        eq(simJobs.parentJobId, parent.id),
        eq(simJobs.wave, 2),
        inArray(simJobs.status, [
          "pending",
          "submitted",
          "running",
          "ingesting",
        ]),
      ),
    );
  const retriedConditionIds = new Set(
    children
      .map(
        (child) =>
          ((child.requestPayload ?? {}) as { conditionId?: string })
            .conditionId,
      )
      .filter((id): id is string => Boolean(id)),
  );

  const [a] = await db
    .select()
    .from(airfoils)
    .where(eq(airfoils.id, parent.airfoilId))
    .limit(1);
  if (!a) return;
  const [capacity] = await db
    .select({ cpuSlots: sweeperState.cpuSlots })
    .from(sweeperState)
    .where(eq(sweeperState.id, 1))
    .limit(1);
  const revisionIds = [
    ...new Set(conditionMap.map((entry) => entry.revisionId)),
  ];
  const revisions = await db
    .select()
    .from(simulationPresetRevisions)
    .where(inArray(simulationPresetRevisions.id, revisionIds));
  const revisionById = new Map(
    revisions.map((revision) => [revision.id, revision]),
  );

  for (const entry of conditionMap) {
    if (retriedConditionIds.has(entry.conditionId)) continue;
    const revision = revisionById.get(entry.revisionId);
    if (!revision) continue;
    // Invariant: no code path may run >30 s without a heartbeat touch. Each
    // retrying condition does a cache refresh + retry plan + engine submit.
    await touchHeartbeat(db);
    await refreshPolarCacheForRevision(db, parent.airfoilId, entry.revisionId);
    const plannedRetry = await ransRetryPlanForJobScoped(db, {
      parentJobId: parent.id,
      airfoilId: parent.airfoilId,
      revisionId: entry.revisionId,
      scope: opts.sourceResultAttemptIds?.length
        ? {
            origin: "explicit-targeted",
            requestedAoas: anglesForJob(parent),
          }
        : parseRansRetryScope(entry.ransRetryScope, anglesForJob(parent)),
      attemptRevisionId: entry.revisionId,
      sourceResultAttemptIds: opts.sourceResultAttemptIds,
    });
    const retry =
      plannedRetry?.retryMode === "whole-polar-urans"
        ? plannedRetry
        : plannedRetry
          ? await withoutExistingPrecalcCoverage(db, {
              parentJobId: parent.id,
              airfoilId: parent.airfoilId,
              revisionId: entry.revisionId,
              retry: plannedRetry,
              meshRecoveryVersion: opts.meshRecoveryVersion ?? 0,
            })
          : null;
    if (!retry || retry.aoas.length === 0) continue;
    const enginePromotion = opts.ransPrecalcPromotions?.find(
      (promotion) =>
        promotion.revisionId === entry.revisionId &&
        promotion.conditionId === entry.conditionId,
    );
    if (opts.recordPromotionsOnly && !enginePromotion) continue;
    if (enginePromotion && retry.retryMode !== "whole-polar-urans") {
      throw new Error(
        `engine aborted RANS for preliminary promotion but exact Node policy did not authorize condition scope (job ${parent.id}, condition ${entry.conditionId})`,
      );
    }
    if (retry.retryMode === "whole-polar-urans") {
      const triggerResultAttemptId =
        enginePromotion?.triggerResultAttemptId ??
        retry.wholePolarTriggerResultAttemptId;
      const triggerAoaDeg =
        enginePromotion?.triggerAoaDeg ?? retry.wholePolarTriggerAoaDeg;
      if (
        !opts.ingestLeaseToken ||
        !triggerResultAttemptId ||
        triggerAoaDeg == null
      )
        continue;
      const recorded = await recordRansPolarPromotion(db, {
        parentJobId: parent.id,
        ingestLeaseToken: opts.ingestLeaseToken,
        airfoilId: parent.airfoilId,
        revisionId: entry.revisionId,
        conditionId: entry.conditionId,
        triggerResultAttemptId,
        triggerAoaDeg,
        requestedAoas: retry.aoas,
        intentionallyOmittedAoas:
          enginePromotion?.intentionallyOmittedAoas ?? [],
        ownership: {
          campaignIds: parent.campaignId ? [parent.campaignId] : [],
          backgroundOwner: parent.campaignId == null && !remoteProvenance,
          syncPromiseIds: remoteProvenance
            ? [remoteProvenance.syncPromiseId]
            : [],
        },
      });
      if (!recorded) {
        throw new Error(
          `conditional whole-polar promotion failed atomic preconditions (job ${parent.id}, condition ${entry.conditionId})`,
        );
      }
      continue;
    }
    const obligations = await ensurePrecalcObligations(
      db,
      retry.aoas.map((aoaDeg) => ({
        airfoilId: parent.airfoilId,
        revisionId: entry.revisionId,
        aoaDeg,
      })),
      {
        campaignIds: parent.campaignId ? [parent.campaignId] : [],
        backgroundOwner: parent.campaignId == null && !remoteProvenance,
        syncPromiseIds: remoteProvenance
          ? [remoteProvenance.syncPromiseId]
          : [],
      },
    );
    if (opts.recordRoutesOnly) continue;
    if (campaignGated) continue;
    const continuations = await precalcContinuationsForObligations(
      db,
      obligations
        .filter((obligation) => obligation.state === "pending")
        .map((obligation) => obligation.id),
    );
    const continuationIds = new Set(
      continuations.map((continuation) => continuation.obligationId),
    );
    const durableRecoveryAvailable = supportsDurableUransRecovery(
      opts.uransRecoveryVersion,
    );
    const schedulableByAoa = new Map(
      obligations
        .filter(
          (obligation) =>
            obligation.state === "pending" &&
            (continuationIds.has(obligation.id)
              ? durableRecoveryAvailable
              : obligation.attemptCount < obligation.maxAttempts) &&
            (!obligation.nextSubmitAt ||
              new Date(obligation.nextSubmitAt).getTime() <= Date.now()),
        )
        .map((obligation) => [obligation.aoaDeg, obligation]),
    );
    let retryAoas = retry.aoas.filter((aoa) => schedulableByAoa.has(aoa));
    if (!retryAoas.length) continue;
    let obligationIds = retryAoas.map((aoa) => schedulableByAoa.get(aoa)!.id);
    const continuation = durableRecoveryAvailable
      ? continuations.find((candidate) =>
          obligationIds.includes(candidate.obligationId),
        )
      : undefined;
    if (continuation) {
      retryAoas = [continuation.aoaDeg];
      obligationIds = [continuation.obligationId];
    }
    const snapshot = revision.snapshot as unknown as SimulationSetupSnapshot;
    let executionPool;
    try {
      executionPool = await requireExecutionPoolForSetup(db, snapshot);
    } catch (error) {
      if (!(error instanceof SolverExecutionPoolUnavailableError)) throw error;
      console.error(
        `[sweeper] URANS routing for job ${parent.id}, condition ${entry.conditionId} deferred: ${error.message}`,
      );
      continue;
    }
    const { request, speed } = buildPolarRequest({
      airfoil: a,
      setup: snapshot,
      aoaList: retryAoas,
      wave: 2,
      uransFidelity: "precalc",
      cpuSlots: capacity?.cpuSlots ?? 0,
    });
    request.expected_execution_pool = executionPool.routingKey;
    request.expected_mesh_recovery_version = opts.meshRecoveryVersion ?? 0;
    if (continuation) {
      request.expected_urans_recovery_version = opts.uransRecoveryVersion!;
      request.continue_from = {
        engine_job_id: continuation.engineJobId,
        case_slug: continuation.engineCaseSlug,
      };
      request.budget_override_s = continuation.budgetOverrideS;
    }
    const job = await composeWave2Child(db, {
      parentJobId: parent.id,
      revisionId: entry.revisionId,
      conditionId: entry.conditionId,
      obligationIds,
      job: {
        parentJobId: parent.id,
        airfoilId: a.id,
        bcIds: [entry.bcId],
        simulationPresetRevisionId: entry.revisionId,
        solverImplementationId: solverImplementationIdForSetup(snapshot),
        solverExecutionPoolId: executionPool.id,
        methodKey: "openfoam.urans",
        campaignId: null,
        jobKind: "targeted",
        referenceChordM: snapshot.referenceGeometry.referenceLengthM,
        wave: 2,
        status: "pending",
        totalCases: retryAoas.length,
        requestPayload: {
          ...(remoteProvenance ?? {}),
          speedMap: [
            {
              speed,
              bcId: entry.bcId,
              presetRevisionId: entry.revisionId,
              mach: snapshot.flowState.mach,
            },
          ],
          aoas: retryAoas,
          parentJobId: parent.id,
          conditionId: entry.conditionId,
          precalcObligationIds: obligationIds,
          ...(continuation
            ? {
                continueFromResultId: continuation.resultId,
                continueFromResultAttemptId: continuation.resultAttemptId,
                budgetOverrideS: continuation.budgetOverrideS,
                uransRecoveryVersion: opts.uransRecoveryVersion,
              }
            : {}),
          uransFidelity: "precalc",
          meshRecoveryVersion: opts.meshRecoveryVersion ?? 0,
          retryMode: retry.retryMode,
          validRansPointCount: retry.validRansPointCount,
          needsUransCount: retry.needsUransCount,
          hardRejectedCount: retry.hardRejectedCount,
          resources: request.resources,
          setupSnapshot: snapshot,
        },
      },
    });
    if (!job) continue;

    const submit = await submitPendingJobWithLifecycleGuard({
      db,
      engine,
      jobId: job.id,
      campaignId: null,
      request,
      connectionErrorPrefix: "engine unreachable at URANS submit: ",
      submitErrorPrefix: "URANS submit failed: ",
      precalcObligationIds: obligationIds,
    });
    if (submit.kind === "submitted") {
      await recordPrecalcObligationSubmission(db, job.id, obligationIds);
      console.log(
        `[sweeper] URANS retry submitted → engine ${submit.status.job_id} (sim_job ${job.id}, parent ${parent.id}, campaign ${parent.campaignId ?? "-"}, airfoil ${parent.airfoilId}, condition ${entry.conditionId}, precalc, angles [${retryAoas.join(", ")}])`,
      );
      // One capacity-bounded ladder pass may admit only one physical child.
      // A batched parent can contain many independently retryable conditions;
      // continuing this loop would jump past maxConcurrentJobs and skip the
      // promised RANS/PRECALC fairness handoff.
      return;
    }
    if (submit.kind === "submission_in_progress") return;
    if (
      submit.kind !== "lifecycle_stopped" ||
      (await campaignIsPaused(db, parent.campaignId))
    ) {
      await restoreUnsubmittedWave2Route(db, {
        airfoilId: a.id,
        revisionId: entry.revisionId,
        aoas: retryAoas,
      });
    }
    if (submit.kind === "capability_mismatch") {
      console.warn(
        `[sweeper] PRECALC submit deferred by engine capability cutover (sim_job ${job.id}, parent ${parent.id}, condition ${entry.conditionId}); capability will be re-probed next tick`,
      );
      return;
    }
    if (submit.kind === "connection_failure") {
      await recordEngineUnreachable(db);
      return;
    }
    if (submit.kind === "lifecycle_stopped") {
      console.log(
        `[sweeper] URANS retry stopped by campaign lifecycle (sim_job ${job.id}, parent ${parent.id}, campaign ${parent.campaignId ?? "-"}, condition ${entry.conditionId}): ${submit.error}` +
          (submit.engineCancelError
            ? `; compensating cancel pending: ${submit.engineCancelError}`
            : ""),
      );
      return;
    }
    console.error(
      `[sweeper] URANS retry submit failed (sim_job ${job.id}, parent ${parent.id}, condition ${entry.conditionId}): ${submit.error}`,
    );
  }
}

/** Post-refresh campaign settlement: the ingest-time completion probe fires
 *  BEFORE the polar cache refresh classifies fresh rows (it blocks on those
 *  unjudged points), so after the refresh the campaign's counters must absorb
 *  the verdicts (rejected bucket) and the probe must run again to settle
 *  completed vs attention honestly. */
export async function settleCampaignAfterRefresh(
  db: DB,
  job: SimJobRow,
): Promise<void> {
  const payload = (job.requestPayload ?? {}) as {
    uransRequestId?: unknown;
    verifyQueueItemId?: unknown;
    aoas?: unknown;
  };
  const requestId =
    typeof payload.uransRequestId === "string" ? payload.uransRequestId : null;
  const verifyQueueItemId =
    typeof payload.verifyQueueItemId === "string"
      ? payload.verifyQueueItemId
      : null;
  const aoas = Array.isArray(payload.aoas)
    ? payload.aoas.filter(
        (aoa): aoa is number => typeof aoa === "number" && Number.isFinite(aoa),
      )
    : [];
  const directOwner = job.campaignId
    ? sql`SELECT ${job.campaignId}::uuid AS campaign_id`
    : sql`SELECT NULL::uuid AS campaign_id WHERE false`;
  const requestOwners = requestId
    ? sql`SELECT campaign_id FROM sim_urans_request_campaigns WHERE request_id::text = ${requestId}`
    : sql`SELECT NULL::uuid AS campaign_id WHERE false`;
  const verifyOwners = verifyQueueItemId
    ? sql`
        SELECT campaign_id
        FROM sim_urans_verify_queue_campaigns
        WHERE queue_id::text = ${verifyQueueItemId}
        UNION
        SELECT request_ownership.campaign_id
        FROM sim_urans_verify_queue_requests coverage
        JOIN sim_urans_request_campaigns request_ownership
          ON request_ownership.request_id = coverage.request_id
        WHERE coverage.queue_id::text = ${verifyQueueItemId}
      `
    : sql`SELECT NULL::uuid AS campaign_id WHERE false`;
  // Association rows are authoritative. The physical-cell fallback also
  // catches a campaign attached after a background/shared solve was already
  // submitted but before its refreshed evidence settled.
  const pointOwners =
    job.simulationPresetRevisionId && aoas.length
      ? sql`
        SELECT DISTINCT campaign_id
        FROM sim_campaign_points
        WHERE airfoil_id = ${job.airfoilId}
          AND revision_id = ${job.simulationPresetRevisionId}
          AND aoa_deg = ANY(${sql`ARRAY[${sql.join(
            aoas.map((aoa) => sql`${aoa}::float8`),
            sql`, `,
          )}]`})
          AND state <> 'released'
      `
      : sql`SELECT NULL::uuid AS campaign_id WHERE false`;
  const owners = (await db.execute(sql`
    SELECT DISTINCT owner.campaign_id
    FROM (
      ${directOwner}
      UNION ALL ${requestOwners}
      UNION ALL ${verifyOwners}
      UNION ALL ${pointOwners}
    ) owner
    WHERE owner.campaign_id IS NOT NULL
    ORDER BY owner.campaign_id
  `)) as unknown as Array<{ campaign_id: string }>;

  for (const owner of owners) {
    try {
      await recomputeProgressForCampaign(db, owner.campaign_id);
      await probeCampaignCompletion(db, owner.campaign_id);
    } catch (e) {
      // Counters/probe hiccups (e.g. a recompute deadlock against the periodic
      // reconciler) must not fail an already-ingested job — the reconciler
      // heals counters and re-probes within its 5-minute sweep. Loud, never silent.
      console.error(
        `[sweeper] campaign settle failed (campaign ${owner.campaign_id}, job ${job.id}): ${errorMessage(e)}`,
      );
    }
  }
}

/** Auto-retry-once (amendment B): requeue this job's unmarked crash-class
 *  failed rows exactly once and log every terminal direction loudly — retry,
 *  output-only media repair deferral, deterministic mesh-QA suppression, and
 *  exhausted escalation. Runs AFTER
 *  every polar-cache refresh of the terminal ingest path (flipping a row to
 *  pending before a refresh would overwrite its stored at-ingest
 *  classification — prod row 741db07a) and AFTER the wave-2 retry submit
 *  (angles the URANS ladder just claimed are queued, not failed, so the two
 *  retry mechanisms can never double-schedule one cell). Never throws: a
 *  bookkeeping hiccup must not fail an already-ingested job. */
async function autoRetryFailedPointsForJob(
  db: DB,
  job: SimJobRow,
): Promise<void> {
  try {
    const outcome = await autoRetryCrashedResultsForJob(db, job.id);
    for (const cell of outcome.retried) {
      console.error(
        `[sweeper] AUTO-RETRY: crash-class failed point requeued ONCE (result ${cell.resultId}, airfoil ${cell.airfoilId}, aoa ${cell.aoaDeg}, sim_job ${job.id}, engine ${job.engineJobId ?? "-"}): ${cell.error ?? "no error text"} — a second crash remains failed and blocked`,
      );
    }
    for (const cell of outcome.precalcRouted) {
      console.error(
        `[sweeper] AUTO-RETRY: precalc crash routed ONCE to the wave-2 ladder (result ${cell.resultId}, airfoil ${cell.airfoilId}, revision ${cell.revisionId ?? "-"}, aoa ${cell.aoaDeg}, sim_job ${job.id}, engine ${job.engineJobId ?? "-"}): ${cell.error ?? "no error text"} — queued for another forced-transient precalc child; never downgraded to a wave-1 campaign gap`,
      );
    }
    for (const cell of outcome.mediaRepairDeferred) {
      console.log(
        `[sweeper] MEDIA REPAIR: completed solver evidence awaits its default URANS video (result ${cell.resultId}, airfoil ${cell.airfoilId}, revision ${cell.revisionId ?? "-"}, aoa ${cell.aoaDeg}, sim_job ${job.id}, engine ${job.engineJobId ?? "-"}) — bounded media repair owns this; no duplicate CFD solve will be submitted`,
      );
    }
    for (const cell of outcome.suppressed) {
      console.error(
        `[sweeper] AUTO-RETRY SUPPRESSED: deterministic mesh QA blocker on immutable solver setup (result ${cell.resultId}, airfoil ${cell.airfoilId}, revision ${cell.revisionId ?? "-"}, aoa ${cell.aoaDeg}, sim_job ${job.id}, engine ${job.engineJobId ?? "-"}): ${cell.error ?? "no error text"} — unchanged retry would reproduce the same mesh; evidence retained, point stays blocked until automatic mesh recovery or a setup correction is available`,
      );
    }
    for (const cell of outcome.terminalBlocked) {
      console.error(
        `[sweeper] PRECALC RETRY BLOCKED: no authorized retry remains (result ${cell.resultId}, airfoil ${cell.airfoilId}, revision ${cell.revisionId ?? "-"}, aoa ${cell.aoaDeg}, sim_job ${job.id}, engine ${job.engineJobId ?? "-"}): ${cell.error ?? "no error text"} — evidence retained as failed; cancelled owners are not reopened and bounded continuations are not repeated`,
      );
    }
    for (const cell of outcome.escalated) {
      console.error(
        `[sweeper] AUTO-RETRY EXHAUSTED: point failed again after its automatic retry (result ${cell.resultId}, airfoil ${cell.airfoilId}, aoa ${cell.aoaDeg}, sim_job ${job.id}, engine ${job.engineJobId ?? "-"}): ${cell.error ?? "no error text"} — stays failed and blocked; no human coefficient review is assigned`,
      );
    }
  } catch (e) {
    console.error(
      `[sweeper] auto-retry pass FAILED (sim_job ${job.id}): ${errorMessage(e)}`,
    );
  }
}

async function renewIngestAndHeartbeat(
  db: DB,
  lease: Pick<IngestLease, "jobId" | "token">,
): Promise<void> {
  await renewIngestLeaseOrThrow(db, lease);
  await touchHeartbeat(db);
}

async function ingestCompletedJob(
  db: DB,
  engine: EngineClient,
  job: SimJobRow,
): Promise<void> {
  if (!job.engineJobId) return;
  const engineJobId = job.engineJobId;
  const lease = await claimJobForIngest(db, job.id);
  if (!lease) return;
  try {
    const result = await engine.getResult(engineJobId, {
      expectedEngine: expectedEngineForJob(job),
      expectedExecutionPool: await expectedExecutionPoolForJob(db, job),
    });
    await renewIngestLeaseOrThrow(db, lease);
    job = await jobWithPersistedMeshRecoveryAcknowledgement(
      db,
      job,
      result.mesh_recovery_version,
      result.engine,
      lease,
    );
    const speedMap = speedMapForJob(job);
    const ingested = await ingestResult({
      db,
      engine,
      engineJobId,
      simJobId: job.id,
      airfoilId: job.airfoilId,
      speedMap,
      conditionMap: conditionMapForJob(job) ?? undefined,
      jobAoas: anglesForJob(job),
      uransFidelity: uransFidelityForJob(job),
      result,
      ingestLeaseToken: lease.token,
      heartbeat: () => renewIngestAndHeartbeat(db, lease),
    });
    collectDirtyLanes(ingested.dirtyLanes);
    await renewIngestLeaseOrThrow(db, lease);
    await refreshPolarCachesForJob(db, job, () =>
      renewIngestAndHeartbeat(db, lease),
    );
    // Fidelity ladder: fresh verdicts exist now — enqueue verifications for
    // accepted precalc rows and settle verify/request bookkeeping.
    await renewIngestLeaseOrThrow(db, lease);
    await enqueueVerificationsForJob(db, job);
    await settleUransLadderForJob(db, job);
    await renewIngestLeaseOrThrow(db, lease);
    await submitUransRetryForJob(db, engine, job, {
      ingestLeaseToken: lease.token,
      ransPrecalcPromotions: ingested.ransPrecalcPromotions,
    });
    // Amendment B: a COMPLETED job can still ship individual crashed points
    // (per-case solver error → failed rows) — same one-shot requeue.
    await autoRetryFailedPointsForJob(db, job);
    await settleCampaignAfterRefresh(db, job);
    const [finished] = await db
      .update(simJobs)
      .set({
        status: "done",
        engineState: "completed",
        // A normal completed result terminalizes every composed case. A typed
        // conditional RANS abort intentionally omits later angles; count only
        // attempted cases and let normalized promotion obligations own the rest.
        completedCases:
          job.totalCases -
          ingested.ransPrecalcPromotions.reduce(
            (sum, promotion) => sum + promotion.intentionallyOmittedAoas.length,
            0,
          ),
        error: null,
        ingestedAt: new Date(),
        finishedAt: new Date(),
        ingestLeaseToken: null,
        ingestLeaseClaimedAt: null,
        ingestLeaseExpiresAt: null,
      })
      .where(ingestLeaseOwnedWhere(job.id, lease.token))
      .returning({ id: simJobs.id });
    if (!finished) throw new IngestLeaseLostError(job.id);
  } catch (error) {
    await markIngestRetry(db, job.id, error, lease);
    throw error;
  }
}

function precalcObligationIdsForJob(job: SimJobRow): string[] {
  if (uransFidelityForJob(job) !== "precalc") return [];
  const obligationIds = (
    requestPayload(job) as { precalcObligationIds?: unknown }
  ).precalcObligationIds;
  if (!Array.isArray(obligationIds)) return [];
  return [...new Set(obligationIds)].filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
}

/** Retry the durable FAST→FINAL projection independently from engine result
 * counts. Point ingest and this ownership handoff are separate commits; after
 * a crash the database can already contain accepted exact evidence while the
 * engine and sim_job completed-case counters are equal, so no result fetch is
 * warranted. Failure is intentionally local to this projection: the engine
 * job remains running and ordinary polling continues while every later tick
 * retries the exact idempotent transaction. */
async function reconcileRunningPrecalcHandoff(
  db: DB,
  job: SimJobRow,
): Promise<void> {
  const obligationIds = precalcObligationIdsForJob(job);
  if (!obligationIds.length) return;
  try {
    const settled = await settleAcceptedRunningPrecalcPartials(db, {
      simJobId: job.id,
      obligationIds,
    });
    const changed = settled.filter(
      (item) => item.changed || item.verifyQueueCreated,
    ).length;
    if (changed > 0) {
      console.log(
        `[sweeper] running PRECALC handoff reconciled ${changed} newly accepted point(s) or exact FINAL verification generation(s) (sim_job ${job.id}, engine ${job.engineJobId ?? "unsubmitted"})`,
      );
    }
  } catch (error) {
    console.error(
      `[sweeper] running PRECALC handoff retry deferred for sim_job ${job.id} (engine ${job.engineJobId ?? "unsubmitted"}): ${errorMessage(error)}`,
    );
  }
}

async function ingestRunningPartialJob(
  db: DB,
  engine: EngineClient,
  job: SimJobRow,
): Promise<boolean> {
  if (!job.engineJobId) return false;
  const engineJobId = job.engineJobId;
  const lease = await claimJobForIngest(db, job.id);
  if (!lease) return false;
  let result;
  try {
    result = await engine.getResult(engineJobId, {
      expectedEngine: expectedEngineForJob(job),
      expectedExecutionPool: await expectedExecutionPoolForJob(db, job),
    });
  } catch {
    await releaseIngestLeaseToRunning(db, lease);
    return false;
  }
  if (result.state !== "running") {
    await releaseIngestLeaseToRunning(db, lease);
    return false;
  }
  try {
    await renewIngestLeaseOrThrow(db, lease);
    job = await jobWithPersistedMeshRecoveryAcknowledgement(
      db,
      job,
      result.mesh_recovery_version,
      result.engine,
      lease,
    );
    const ingested = await ingestResult({
      db,
      engine,
      engineJobId,
      simJobId: job.id,
      airfoilId: job.airfoilId,
      speedMap: speedMapForJob(job),
      conditionMap: conditionMapForJob(job) ?? undefined,
      jobAoas: anglesForJob(job),
      uransFidelity: uransFidelityForJob(job),
      result,
      ingestLeaseToken: lease.token,
      heartbeat: () => renewIngestAndHeartbeat(db, lease),
    });
    collectDirtyLanes(ingested.dirtyLanes);
    if (ingested.points > 0 || ingested.ransPrecalcPromotions.length > 0) {
      await renewIngestLeaseOrThrow(db, lease);
      await refreshPolarCachesForJob(db, job, () =>
        renewIngestAndHeartbeat(db, lease),
      );
    }
    if (uransFidelityForJob(job) === "precalc") {
      await renewIngestLeaseOrThrow(db, lease);
      await reconcileRunningPrecalcHandoff(db, job);
    }
    if (ingested.ransPrecalcPromotions.length > 0) {
      await renewIngestLeaseOrThrow(db, lease);
      await submitUransRetryForJob(db, engine, job, {
        ingestLeaseToken: lease.token,
        ransPrecalcPromotions: ingested.ransPrecalcPromotions,
        recordPromotionsOnly: true,
      });
    }
    if (ingested.points > 0) {
      // Non-converged/stalled RANS evidence is normal fidelity-ladder input,
      // not a terminal campaign outcome. Persist its exact targeted PRECALC
      // route during partial ingestion; external submission remains bounded
      // by the sweeper tick rather than exceeding worker capacity here.
      await renewIngestLeaseOrThrow(db, lease);
      await submitUransRetryForJob(db, engine, job, {
        ingestLeaseToken: lease.token,
        recordRoutesOnly: true,
      });
      // Amendment B, live gap 2026-07-08 (campaign 495d78e0, s1223 −5°): a
      // divergence-condemned case terminalizes its point MID-RUN. The
      // one-shot retry runs after the at-ingest classification refresh.
      await autoRetryFailedPointsForJob(db, job);
    }
    const changed =
      ingested.points > 0 ||
      ingested.media > 0 ||
      ingested.ransPrecalcPromotions.length > 0;
    if (!(await releaseIngestLeaseToRunning(db, lease))) {
      throw new IngestLeaseLostError(job.id);
    }
    return changed;
  } catch (error) {
    await markIngestRetry(db, job.id, error, lease);
    throw error;
  }
}

function speedMapForJob(job: SimJobRow): SpeedBc[] {
  const rawSpeedMap = ((job.requestPayload as { speedMap?: SpeedBc[] } | null)
    ?.speedMap ?? []) as SpeedBc[];
  return rawSpeedMap.map((row) => ({
    ...row,
    presetRevisionId:
      row.presetRevisionId ?? job.simulationPresetRevisionId ?? null,
  }));
}

/** Guarantee every failure message stamped onto evidence rows is non-empty:
 *  ERROR_CLASS_SQL (packages/db/src/campaigns.ts) buckets NULL/'' as
 *  'unknown', which is exactly how the 2026-07-04 worker-restart incident
 *  surfaced ("15 failed", errorClass unknown, no error text anywhere). */
function nonEmptyFailureMessage(job: SimJobRow, msg: string): string {
  return msg.trim()
    ? msg
    : `engine job failed without a message (job ${job.engineJobId ?? job.id})`;
}

/** Keep ONLY solved points of a partial result: worker-restart orphan ingest
 *  must preserve real solved evidence while every unreached/unsolved point is
 *  released for a re-solve — never ingested as failure evidence. Attempt rows
 *  survive unfiltered: they are historical solver attempts that genuinely
 *  happened before the restart (result_attempts evidence, not results rows). */
function solvedPointsOnly(result: JobResult): JobResult {
  return {
    ...result,
    polars: result.polars.map((polar) => ({
      ...polar,
      points: polar.points.filter((p) => !failedForPoint(p)),
    })),
  };
}

/** Worker-restart orphan (incident 2026-07-04): the engine's worker-boot
 *  reconciliation (src/airfoilfoam/storage.py reconcile_orphans) marks jobs
 *  whose celery task died with a restarted worker container as state=failed
 *  with the pinned WORKER_RESTART_ORPHAN_MESSAGE. That is an infrastructure
 *  interruption, NOT solver failure evidence — before this branch existed the
 *  failed-job ingest terminal-failed 12 campaign points (+3 symmetry mirrors)
 *  with empty error text for points that were merely interrupted.
 *
 *  Truthful handling: solved cases present in the partial result.json are
 *  real evidence and ingest as done; every remaining claimed row is RELEASED
 *  back to pending (the cancelJobAndReleaseClaims claim-release semantics, so
 *  the gap finders re-claim the points next tick) and the sim_job terminates
 *  'cancelled'. NOTHING is marked failed, so campaign points never
 *  terminal-fail on a restart. No URANS retry is submitted here: policy reads
 *  only exact job-local attempts with structured failure provenance, and the
 *  released unsolved rows have no solver attempt at all. Infrastructure loss
 *  can therefore neither target nor widen URANS; the follow-up RANS job owns
 *  those released cells. */
async function releaseWorkerRestartOrphan(
  db: DB,
  engine: EngineClient,
  job: SimJobRow,
  lease: IngestLease,
): Promise<void> {
  let solvedPoints = 0;
  if (job.engineJobId) {
    try {
      const result = await engine.getResult(job.engineJobId, {
        expectedEngine: expectedEngineForJob(job),
        expectedExecutionPool: await expectedExecutionPoolForJob(db, job),
      });
      const ingested = await ingestResult({
        db,
        engine,
        engineJobId: job.engineJobId,
        simJobId: job.id,
        airfoilId: job.airfoilId,
        speedMap: speedMapForJob(job),
        conditionMap: conditionMapForJob(job) ?? undefined,
        jobAoas: anglesForJob(job),
        uransFidelity: uransFidelityForJob(job),
        result: solvedPointsOnly(result),
        ingestLeaseToken: lease.token,
        heartbeat: () => renewIngestAndHeartbeat(db, lease),
      });
      collectDirtyLanes(ingested.dirtyLanes);
      solvedPoints = ingested.points;
    } catch (e) {
      if (e instanceof IngestLeaseLostError) {
        console.error(
          `[sweeper] ${e.message}; stale orphan-recovery owner stopped`,
        );
        return;
      }
      if (e instanceof TerminalEvidenceCleanupPendingError) {
        await markIngestRetry(db, job.id, e, lease);
        throw e;
      }
      // No readable partial result (or ingest hiccup): nothing solved to
      // preserve — release everything below. Loud, never silent.
      console.error(
        `[sweeper] worker-restart orphan ${job.engineJobId} (sim_job ${job.id}): partial-result ingest unavailable (${errorMessage(e)}); releasing all claims`,
      );
    }
  }
  console.error(
    `[sweeper] WORKER RESTART orphan ${job.engineJobId ?? "(unsubmitted)"} (sim_job ${job.id}): ${solvedPoints} solved point(s) kept as evidence, remaining claims released for re-solve — nothing marked failed`,
  );
  if (solvedPoints > 0) {
    await renewIngestLeaseOrThrow(db, lease);
    await refreshPolarCachesForJob(db, job, () =>
      renewIngestAndHeartbeat(db, lease),
    );
    await enqueueVerificationsForJob(db, job);
    await settleCampaignAfterRefresh(db, job);
  }
  if (
    !(await cancelJobAndReleaseClaims(
      db,
      job,
      "worker restarted mid-solve; points released for re-solve",
      lease,
    ))
  ) {
    throw new IngestLeaseLostError(job.id);
  }
}

/** Angle list a job was composed for (requestPayload.aoas) — loud-event
 *  addressing only; absent/odd payloads render as an empty list. */
function anglesForJob(job: SimJobRow): number[] {
  const raw = (requestPayload(job) as { aoas?: unknown }).aoas;
  return Array.isArray(raw)
    ? raw.filter(
        (a): a is number => typeof a === "number" && Number.isFinite(a),
      )
    : [];
}

/** One-line job-failed event (gate incident 2026-07-07: campaign a1802299's
 *  only job failed and the sweeper logged NOTHING between claim and terminal
 *  failure). Every terminal failed-ingest outcome emits exactly one of these
 *  with full addressing + an explicit verdict. */
function logEngineJobFailed(
  job: SimJobRow,
  failure: string,
  counts: { points: number; attempts: number },
  verdict: string,
): void {
  console.error(
    `[sweeper] engine job FAILED (engine ${job.engineJobId ?? "-"}, sim_job ${job.id}, campaign ${job.campaignId ?? "-"}, airfoil ${job.airfoilId}, angles [${anglesForJob(job).join(", ")}]): ${failure} — ${counts.points} point(s), ${counts.attempts} attempt(s) ingested; ${verdict}`,
  );
}

async function ingestFailedEngineJob(
  db: DB,
  engine: EngineClient,
  job: SimJobRow,
  msg: string,
  hooks: ReconcileOptions["testHooks"] = {},
  statusFailureDisposition: JobStatus["failure_disposition"] = null,
  statusContinuationFailureKind: JobStatus["continuation_failure_kind"] = null,
): Promise<void> {
  const lease = await claimJobForIngest(db, job.id);
  if (!lease) return;
  let terminalFailureDisposition = statusFailureDisposition ?? null;
  let terminalContinuationFailureKind = statusContinuationFailureKind ?? null;
  if (msg === WORKER_RESTART_ORPHAN_MESSAGE) {
    // Infrastructure interruption, not solver failure — release, never fail.
    await releaseWorkerRestartOrphan(db, engine, job, lease);
    return;
  }
  if (!job.engineJobId) {
    const failure = nonEmptyFailureMessage(job, msg);
    logEngineJobFailed(
      job,
      failure,
      { points: 0, attempts: 0 },
      "never submitted to the engine; rows failed",
    );
    if (!(await markOwnedJobResultsFailed(db, job.id, failure, lease, hooks)))
      return;
    await settleUransLadderForJob(db, job, {
      terminalError: failure,
      terminalFailureDisposition,
      terminalContinuationFailureKind,
    });
    await autoRetryFailedPointsForJob(db, job);
    if (!(await finalizeOwnedFailedJob(db, job.id, failure, lease))) {
      throw new IngestLeaseLostError(job.id);
    }
    return;
  }
  const engineJobId = job.engineJobId;
  let result: JobResult;
  try {
    result = await engine.getResult(engineJobId, {
      expectedEngine: expectedEngineForJob(job),
      expectedExecutionPool: await expectedExecutionPoolForJob(db, job),
    });
  } catch (e) {
    try {
      job = await jobWithPersistedMeshRecoveryAcknowledgement(
        db,
        job,
        undefined,
        undefined,
        lease,
      );
    } catch (refreshError) {
      if (refreshError instanceof IngestLeaseLostError) return;
      throw refreshError;
    }
    const failure = nonEmptyFailureMessage(job, msg);
    logEngineJobFailed(
      job,
      failure,
      { points: 0, attempts: 0 },
      `result payload unreadable (${errorMessage(e)}); rows failed with the status message`,
    );
    if (!(await markOwnedJobResultsFailed(db, job.id, failure, lease, hooks)))
      return;
    await settleUransLadderForJob(db, job, {
      terminalError: failure,
      terminalFailureDisposition,
      terminalContinuationFailureKind,
    });
    await autoRetryFailedPointsForJob(db, job);
    if (!(await finalizeOwnedFailedJob(db, job.id, failure, lease))) {
      throw new IngestLeaseLostError(job.id);
    }
    return;
  }
  terminalFailureDisposition =
    result.failure_disposition ?? terminalFailureDisposition;
  terminalContinuationFailureKind =
    result.continuation_failure_kind ?? terminalContinuationFailureKind;
  // The ENGINE's own failure message wins (gate incident 2026-07-07: the
  // runtime-probe dispatch passed the generic "engine job failed" fallback and
  // the real "All cases failed" never reached the evidence rows): prefer the
  // result payload's message, then the caller's status-derived msg, then the
  // pinned non-empty fallback.
  const failure = nonEmptyFailureMessage(
    job,
    typeof result.message === "string" && result.message.trim()
      ? result.message
      : msg,
  );
  try {
    job = await jobWithPersistedMeshRecoveryAcknowledgement(
      db,
      job,
      result.mesh_recovery_version,
      result.engine,
      lease,
    );
    await renewIngestLeaseOrThrow(db, lease);
    const ingested = await ingestResult({
      db,
      engine,
      engineJobId,
      simJobId: job.id,
      airfoilId: job.airfoilId,
      speedMap: speedMapForJob(job),
      conditionMap: conditionMapForJob(job) ?? undefined,
      jobAoas: anglesForJob(job),
      uransFidelity: uransFidelityForJob(job),
      result,
      failedPointErrorFallback: failure,
      ingestLeaseToken: lease.token,
      heartbeat: () => renewIngestAndHeartbeat(db, lease),
    });
    collectDirtyLanes(ingested.dirtyLanes);
    if (ingested.points === 0) {
      if (!(await markOwnedJobResultsFailed(db, job.id, failure, lease, hooks)))
        return;
      if (ingested.attempts === 0) {
        // True crash: the payload shipped no evidence at all — current
        // terminal-fail behavior, now loud. The exact crash-class shape the
        // auto-retry-once amendment covers.
        await settleUransLadderForJob(db, job, {
          terminalError: failure,
          terminalFailureDisposition,
          terminalContinuationFailureKind,
        });
        logEngineJobFailed(
          job,
          failure,
          ingested,
          "no shipped evidence; rows failed",
        );
        await autoRetryFailedPointsForJob(db, job);
        if (!(await finalizeOwnedFailedJob(db, job.id, failure, lease))) {
          throw new IngestLeaseLostError(job.id);
        }
        return;
      }
      // All-rejected job (gate incident 2026-07-07, job a2379532): points: []
      // but polars[].attempts carried the real solver evidence (forces,
      // steady_history, evidence artifacts) — already ingested above. Stamp
      // the job as evidence-ingested (the gated-ladder rescan requires
      // status='failed' AND ingested_at), classify the fresh attempt rows,
      // and keep the wave-2 gated retry reachable: before this branch existed
      // points===0 returned ABOVE submitUransRetryForJob, so a fully-rejected
      // (e.g. single-point) campaign job could never escalate to URANS.
      await renewIngestLeaseOrThrow(db, lease);
      await refreshPolarCachesForJob(db, job, () =>
        renewIngestAndHeartbeat(db, lease),
      );
      await settleUransLadderForJob(db, job, {
        terminalError: failure,
        terminalFailureDisposition,
        terminalContinuationFailureKind,
      });
      logEngineJobFailed(
        job,
        failure,
        ingested,
        "attempt evidence kept on the failed rows; gated URANS retry evaluated",
      );
      await submitUransRetryForJob(db, engine, job, {
        ingestLeaseToken: lease.token,
        ransPrecalcPromotions: ingested.ransPrecalcPromotions,
      });
      // Amendment B: rows the wave-2 retry did NOT claim get their one
      // automatic requeue (after the refresh — at-ingest verdicts preserved).
      await autoRetryFailedPointsForJob(db, job);
      await settleCampaignAfterRefresh(db, job);
      if (
        !(await finalizeOwnedFailedJob(db, job.id, failure, lease, {
          evidenceIngested: true,
        }))
      ) {
        throw new IngestLeaseLostError(job.id);
      }
      return;
    }
    // A terminal payload may re-ship only the cases that produced evidence.
    // Fail every still-owned queued/running cell before classification and
    // auto-retry so omitted sibling cases are not stranded under a dead job.
    // Published points are already done/failed, while late quarantined output
    // no longer owns its cell and is therefore excluded by simJobId.
    if (!(await markOwnedJobResultsFailed(db, job.id, failure, lease, hooks)))
      return;
    await renewIngestLeaseOrThrow(db, lease);
    await refreshPolarCachesForJob(db, job, () =>
      renewIngestAndHeartbeat(db, lease),
    );
    await enqueueVerificationsForJob(db, job);
    await settleUransLadderForJob(db, job, {
      terminalError: failure,
      terminalFailureDisposition,
      terminalContinuationFailureKind,
    });
    logEngineJobFailed(
      job,
      failure,
      ingested,
      "partial evidence ingested; failed rows carry the engine message",
    );
    await renewIngestLeaseOrThrow(db, lease);
    await submitUransRetryForJob(db, engine, job, {
      ingestLeaseToken: lease.token,
      ransPrecalcPromotions: ingested.ransPrecalcPromotions,
    });
    // Amendment B: crashed points of a partially-failed job requeue once.
    await autoRetryFailedPointsForJob(db, job);
    await settleCampaignAfterRefresh(db, job);
    if (
      !(await finalizeOwnedFailedJob(db, job.id, failure, lease, {
        evidenceIngested: true,
      }))
    ) {
      throw new IngestLeaseLostError(job.id);
    }
  } catch (e) {
    if (e instanceof IngestLeaseLostError) {
      console.error(
        `[sweeper] ${e.message}; stale owner stopped without changing the recovered job`,
      );
      return;
    }
    if (e instanceof TerminalEvidenceCleanupPendingError) {
      await markIngestRetry(db, job.id, e, lease);
      return;
    }
    // Loud, never silent (the old bare catch was exactly how a mid-ingest
    // hiccup erased all trace of the shipped evidence).
    logEngineJobFailed(
      job,
      failure,
      { points: 0, attempts: 0 },
      `failed-result ingest errored (${errorMessage(e)}); rows failed`,
    );
    if (!(await markOwnedJobResultsFailed(db, job.id, failure, lease, hooks)))
      return;
    await settleUransLadderForJob(db, job, {
      terminalError: failure,
      terminalFailureDisposition,
      terminalContinuationFailureKind,
    });
    await autoRetryFailedPointsForJob(db, job);
    if (!(await finalizeOwnedFailedJob(db, job.id, failure, lease))) {
      console.error(
        `[sweeper] ingest lease lost while terminalizing failed sim_job ${job.id}`,
      );
    }
  }
}

async function ingestResultFileIfReady(
  db: DB,
  engine: EngineClient,
  job: SimJobRow,
  failedMessage = "engine job failed",
): Promise<boolean> {
  if (!job.engineJobId) return false;
  let result;
  try {
    result = await engine.getResult(job.engineJobId, {
      expectedEngine: expectedEngineForJob(job),
      expectedExecutionPool: await expectedExecutionPoolForJob(db, job),
    });
  } catch {
    return false;
  }
  if (result.state === "completed") {
    await ingestCompletedJob(db, engine, job);
    return true;
  }
  if (result.state === "failed") {
    await ingestFailedEngineJob(
      db,
      engine,
      job,
      result.message ?? failedMessage,
      {},
      result.failure_disposition,
      result.continuation_failure_kind,
    );
    return true;
  }
  if (result.state === "cancelled") {
    // G2 dispatch site 2 (terminal result handling): a cancelled result file
    // is terminal like failed, but its coefficients must NEVER be ingested.
    await cancelJobAndReleaseClaims(
      db,
      job,
      result.message ?? "engine result marks job cancelled; claims released",
      undefined,
      result,
    );
    return true;
  }
  return false;
}

async function recoverFailedEngineJobs(
  db: DB,
  engine: EngineClient,
  ids?: string[],
): Promise<void> {
  const filters = [
    eq(simJobs.status, "failed"),
    isNotNull(simJobs.engineJobId),
    or(
      sql`${simJobs.error} ILIKE 'engine job not found%'`,
      sql`${simJobs.error} ILIKE 'ingest failed:%'`,
      sql`${simJobs.error} ILIKE 'ingest retry pending:%'`,
    ),
  ];
  if (ids?.length) filters.push(inArray(simJobs.id, ids));

  const jobs = await db
    .select()
    .from(simJobs)
    .where(and(...filters))
    .limit(25);

  for (const job of jobs) {
    if (!job.engineJobId) continue;
    // Invariant: no code path may run >30 s without a heartbeat touch. Each
    // recovery candidate can cost an engine round-trip PLUS a full re-ingest;
    // a 25-job sweep must not leave the heartbeat silent meanwhile (2026-07-06:
    // 204 s stale mid-tick read as PROCESS NOT RUNNING on a healthy process).
    await touchHeartbeat(db);
    let status: JobStatus | null = null;
    try {
      status = await engine.getJob(job.engineJobId, {
        expectedEngine: expectedEngineForJob(job),
        expectedExecutionPool: await expectedExecutionPoolForJob(db, job),
      });
    } catch (e) {
      try {
        if (
          await ingestResultFileIfReady(
            db,
            engine,
            job,
            "engine status is unavailable but result file is ready",
          )
        ) {
          continue;
        }
      } catch (ingestError) {
        await markIngestRetry(db, job.id, ingestError);
        continue;
      }
      const listed = await engineQueueMentionsJob(engine, job.engineJobId);
      if (listed) {
        const [restored] = await db
          .update(simJobs)
          .set({
            status: "running",
            engineState: "running",
            error: null,
            polledAt: new Date(),
            finishedAt: null,
            ingestLeaseToken: null,
            ingestLeaseClaimedAt: null,
            ingestLeaseExpiresAt: null,
          })
          .where(reconcilableJobWhere(job.id))
          .returning({ id: simJobs.id });
        if (restored) {
          await db
            .update(results)
            .set({
              status: "running",
              source: "queued",
              engineJobId: job.engineJobId,
            })
            .where(
              and(
                eq(results.simJobId, job.id),
                inArray(results.status, [
                  "failed",
                  "queued",
                  "running",
                  "pending",
                  "stale",
                ]),
              ),
            );
        }
      } else if (
        isNotFound(e) &&
        (job.error ?? "").startsWith("engine job not found")
      ) {
        await requeueLostJob(
          db,
          job,
          "engine job disappeared; safely requeued for a fresh solve",
        );
      }
      continue;
    }

    if (status.state === "pending" || status.state === "running") {
      await db
        .update(results)
        .set({
          status: "running",
          source: "queued",
          engineJobId: job.engineJobId,
        })
        .where(
          and(
            eq(results.simJobId, job.id),
            inArray(results.status, [
              "failed",
              "queued",
              "running",
              "pending",
              "stale",
            ]),
            sql`EXISTS (
              SELECT 1 FROM sim_jobs poll_job
              WHERE poll_job.id = ${job.id}
                AND (
                  poll_job.status <> 'ingesting'
                  OR poll_job.ingest_lease_expires_at <= now()
                  OR (
                    poll_job.ingest_lease_expires_at IS NULL
                    AND poll_job."updatedAt" < now() - (${DEFAULT_INGEST_LEASE_MS} * interval '1 millisecond')
                  )
                )
            )`,
          ),
        );
    }
    await updateJobFromEngineStatus(db, job, status);

    if (status.state === "completed") {
      try {
        await ingestCompletedJob(db, engine, job);
      } catch (e) {
        await markIngestRetry(db, job.id, e);
      }
    } else if (status.state === "failed") {
      await ingestFailedEngineJob(
        db,
        engine,
        job,
        status.message ?? "engine job failed",
        {},
        status.failure_disposition,
        status.continuation_failure_kind,
      );
    }
  }
}

async function keepDetachedRunning(
  db: DB,
  job: SimJobRow,
  runtime: JobRuntimeSummary,
  msg: string,
): Promise<void> {
  await db
    .update(simJobs)
    .set({
      status: "running",
      engineState: runtime.status_state ?? "running",
      totalCases: runtime.status_total_cases ?? job.totalCases,
      completedCases: runtime.status_completed_cases ?? job.completedCases,
      error: msg,
      polledAt: new Date(),
      finishedAt: null,
      ingestLeaseToken: null,
      ingestLeaseClaimedAt: null,
      ingestLeaseExpiresAt: null,
    })
    .where(activeJobWhere(job.id));
}

async function handlePollMiss(
  db: DB,
  engine: EngineClient,
  job: SimJobRow,
  e: unknown,
  queue: EngineQueueState | null,
  runtime: JobRuntimeSummary | null,
): Promise<void> {
  if (!job.engineJobId) return;
  const classified = classifyQueueLifecycle(job, runtime, queue);
  if (runtime?.has_result && runtime.result_readable) {
    if (runtime.result_state === "completed") {
      try {
        await ingestCompletedJob(db, engine, job);
      } catch (ingestError) {
        await markIngestRetry(db, job.id, ingestError);
      }
    } else if (runtime.result_state === "failed") {
      // The engine's REAL failure message lives on the status ("All cases
      // failed" — set_status), not necessarily on the result payload: fall
      // through result → status → generic (gate incident 2026-07-07).
      await ingestFailedEngineJob(
        db,
        engine,
        job,
        runtime.result_message ?? runtime.status_message ?? "engine job failed",
        {},
        runtime.result_failure_disposition ??
          runtime.status_failure_disposition ??
          null,
        runtime.result_continuation_failure_kind ??
          runtime.status_continuation_failure_kind ??
          null,
      );
    } else if (
      runtime.result_state === "running" &&
      runtime.status_completed_cases !== null &&
      runtime.status_completed_cases !== undefined &&
      runtime.status_completed_cases > job.completedCases
    ) {
      await ingestRunningPartialJob(db, engine, job);
    }
    return;
  }

  if (
    classified.processCount > 0 ||
    classified.runtimeState === "detached_running" ||
    (classified.runtimeState === "corrupt_status" &&
      classified.staleReason?.includes("heartbeat"))
  ) {
    await keepDetachedRunning(
      db,
      job,
      runtime ?? {
        job_id: job.engineJobId,
        exists: true,
        cancelled: false,
        process_count: classified.processCount,
        status_readable: false,
        result_readable: false,
        has_result: false,
      },
      classified.staleReason ??
        "engine task is detached from Celery but OpenFOAM processes are still running",
    );
    return;
  }

  if (classified.recoverable) {
    await requeueLostJob(
      db,
      job,
      classified.staleReason ??
        "engine job lost; safely requeued for a fresh solve",
    );
    return;
  }

  const listed = queue
    ? classified.engineQueueMatch
    : await engineQueueMentionsJob(engine, job.engineJobId);
  if (listed) {
    await db
      .update(simJobs)
      .set({
        status: "running",
        engineState: "running",
        error: null,
        polledAt: new Date(),
        finishedAt: null,
        ingestLeaseToken: null,
        ingestLeaseClaimedAt: null,
        ingestLeaseExpiresAt: null,
      })
      .where(activeJobWhere(job.id));
    return;
  }
  if (listed === null || !isNotFound(e)) {
    await db
      .update(simJobs)
      .set({
        error: "engine poll failed: " + errorMessage(e),
        polledAt: new Date(),
        finishedAt: null,
      })
      .where(activeJobWhere(job.id));
    return;
  }

  const missingSince =
    job.engineState === "missing"
      ? (job.polledAt ?? job.submittedAt ?? job.createdAt)
      : null;
  if (
    missingSince &&
    Date.now() - missingSince.getTime() >= MISSING_JOB_REQUEUE_MS
  ) {
    await requeueLostJob(
      db,
      job,
      "engine job stayed missing; safely requeued for a fresh solve",
    );
    return;
  }
  await markPollMiss(
    db,
    job,
    "engine job temporarily missing; waiting before requeue",
  );
}

/** Poll in-flight engine jobs; completed jobs ingest, transient engine misses recover or requeue. */
export async function reconcile(
  db: DB,
  engine: EngineClient,
  options: ReconcileOptions = {},
): Promise<void> {
  if (!options.skipFailedRecovery) {
    await recoverFailedEngineJobs(db, engine, options.recoverFailedJobIds);
  }

  const activeFilters = [
    inArray(simJobs.status, activeJobStatuses),
    outsideLiveIngestLeaseWhere(),
  ];
  if (options.jobIds?.length)
    activeFilters.push(inArray(simJobs.id, options.jobIds));

  const activeJobQuery = db
    .select()
    .from(simJobs)
    .where(and(...activeFilters))
    .orderBy(asc(simJobs.updatedAt), asc(simJobs.id));
  const jobs = options.jobIds?.length
    ? await activeJobQuery
    : await activeJobQuery.limit(activeReconcileJobLimit());

  let queue: EngineQueueState | null = null;
  try {
    queue = await engine.getQueue();
  } catch {
    queue = null;
  }
  const runtimeByJobId = await engineRuntimeMap(
    engine,
    jobs
      .map((job) => job.engineJobId)
      .filter((id): id is string => Boolean(id)),
  );
  const compensatedEngineIds = await retryPersistedCancellationObligations(
    db,
    engine,
    options.jobIds,
  );
  if (queue) {
    await cancelTerminalEngineTasks(
      db,
      engine,
      queue,
      new Set([
        ...jobs
          .map((job) => job.engineJobId)
          .filter((id): id is string => Boolean(id)),
        ...compensatedEngineIds,
      ]),
    );
  }

  for (const job of jobs) {
    await reconcileRunningPrecalcHandoff(db, job);
    if (!job.engineJobId) continue;
    // Engine API calls take seconds when the worker saturates every core; a
    // 10+-job reconcile pass must not leave the heartbeat silent meanwhile.
    await touchHeartbeat(db);
    const runtime = runtimeByJobId.get(job.engineJobId) ?? null;
    let handledRuntimePartial = false;
    if (runtime?.has_result && runtime.result_readable) {
      if (runtime.result_state === "completed") {
        try {
          await ingestCompletedJob(db, engine, job);
        } catch (e) {
          await markIngestRetry(db, job.id, e);
        }
        continue;
      } else if (runtime.result_state === "failed") {
        // Same result → status → generic message fallthrough as handlePollMiss
        // (the runtime dispatch is where "All cases failed" got lost to the
        // generic fallback on the 2026-07-07 gate run).
        await ingestFailedEngineJob(
          db,
          engine,
          job,
          runtime.result_message ??
            runtime.status_message ??
            "engine job failed",
          options.testHooks,
          runtime.result_failure_disposition ??
            runtime.status_failure_disposition ??
            null,
          runtime.result_continuation_failure_kind ??
            runtime.status_continuation_failure_kind ??
            null,
        );
        continue;
      } else if (
        runtime.result_state === "running" &&
        runtime.status_completed_cases !== null &&
        runtime.status_completed_cases !== undefined &&
        runtime.status_completed_cases > job.completedCases
      ) {
        await ingestRunningPartialJob(db, engine, job);
        // The subsequent exact status poll still refreshes engine lifecycle
        // metadata, but must not fetch and ingest the same running snapshot a
        // second time using this function's stale in-memory completedCases.
        handledRuntimePartial = true;
      }
    }
    let status;
    try {
      status = await engine.getJob(job.engineJobId, {
        expectedEngine: expectedEngineForJob(job),
        expectedExecutionPool: await expectedExecutionPoolForJob(db, job),
      });
    } catch (e) {
      try {
        if (
          await ingestResultFileIfReady(
            db,
            engine,
            job,
            "engine poll failed but result file is ready",
          )
        ) {
          continue;
        }
      } catch (ingestError) {
        await markIngestRetry(db, job.id, ingestError);
        continue;
      }
      await handlePollMiss(db, engine, job, e, queue, runtime);
      continue;
    }
    const lostReason = classifyLostRunning(job, status, runtime, queue);
    if (lostReason) {
      // G3: loud by design — this is a worker-restart zombie, not a routine state.
      console.error(
        `[sweeper] LOST engine job ${job.engineJobId} (sim_job ${job.id}): ${lostReason}`,
      );
      try {
        await engine.cancelJob(job.engineJobId);
      } catch (cancelError) {
        console.error(
          `[sweeper] engine-side cancel of lost job ${job.engineJobId} failed: ${errorMessage(cancelError)}`,
        );
      }
      await cancelJobAndReleaseClaims(db, job, lostReason);
      continue;
    }
    if (
      status.state === "running" &&
      status.completed_cases > job.completedCases &&
      !handledRuntimePartial
    ) {
      await ingestRunningPartialJob(db, engine, job);
    }
    await updateJobFromEngineStatus(db, job, status);

    if (status.state === "completed") {
      try {
        await ingestCompletedJob(db, engine, job);
      } catch (e) {
        await markIngestRetry(db, job.id, e);
      }
    } else if (status.state === "failed") {
      await ingestFailedEngineJob(
        db,
        engine,
        job,
        status.message ?? "engine job failed",
        options.testHooks,
        status.failure_disposition,
        status.continuation_failure_kind,
      );
    }
  }

  await drainCampaignMaintenance(db);
}

/** Per-tick cap on dirty-lane processing. A dual-objective campaign dirties
 *  two lanes per ingested point; an unbounded drain after a burst of partial
 *  ingests wedged the tick for ~10 minutes at 10^5-lane scale (2026-07-05),
 *  starving job submission and the heartbeat. The remainder carries over —
 *  pendingDirtyLanes is a Map, so re-dirtied lanes dedupe for free. */
const DIRTY_LANE_DRAIN_CAP = 100;

/** Drain dirty refinement lanes after every reconcile pass (fits are fresh by
 *  now), run the 60 s lane safety sweep and the low-frequency campaign
 *  reconciler (spec §7/§8). All in-memory timers — no schema state. */
async function drainCampaignMaintenance(db: DB): Promise<void> {
  const dirty = [...pendingDirtyLanes.values()].slice(0, DIRTY_LANE_DRAIN_CAP);
  let drained = 0;
  for (const key of dirty) {
    pendingDirtyLanes.delete(laneKeyId(key));
    try {
      await laneTick(db, key);
    } catch (e) {
      console.error(
        "[sweeper] lane tick failed:",
        laneKeyId(key),
        errorMessage(e),
      );
    }
    // Invariant: no code path may run >30 s without a heartbeat touch — a
    // 100-lane drain under DB load must beat mid-drain, not only after it.
    if (++drained % 10 === 0) await touchHeartbeat(db);
  }
  if (pendingDirtyLanes.size > 0) {
    console.log(
      `[sweeper] dirty-lane backlog: ${pendingDirtyLanes.size} lanes carried to next tick`,
    );
  }
  await touchHeartbeat(db);

  const now = Date.now();
  if (now - lastLaneSweepAt >= LANE_SAFETY_SWEEP_MS) {
    lastLaneSweepAt = now;
    try {
      const lanes = await db
        .select({
          campaignId: simCampaignLanes.campaignId,
          airfoilId: simCampaignLanes.airfoilId,
          conditionId: simCampaignLanes.conditionId,
          objective: simCampaignLanes.objective,
        })
        .from(simCampaignLanes)
        .innerJoin(
          simCampaigns,
          eq(simCampaigns.id, simCampaignLanes.campaignId),
        )
        .where(
          and(
            eq(simCampaigns.status, "active"),
            inArray(simCampaignLanes.state, ["awaiting_seed", "iterating"]),
          ),
        )
        .limit(200);
      let sweepCount = 0;
      for (const key of lanes) {
        try {
          await laneTick(db, key);
        } catch (e) {
          console.error(
            "[sweeper] lane sweep tick failed:",
            laneKeyId(key),
            errorMessage(e),
          );
        }
        // Invariant: no code path may run >30 s without a heartbeat touch —
        // per-10 (was per-50): 50 lane ticks at ~1 s each under load is a
        // 50 s silent stretch, past the web's 90 s truth-gate margin.
        if (++sweepCount % 10 === 0) await touchHeartbeat(db);
      }
    } catch (e) {
      console.error("[sweeper] lane safety sweep failed:", errorMessage(e));
    }
  }

  if (now - lastCampaignReconcileAt >= CAMPAIGN_RECONCILE_MS) {
    lastCampaignReconcileAt = now;
    try {
      const healed = await reconcileCampaigns(db);
      let healedCount = 0;
      for (const key of healed.staleLanes) {
        try {
          await laneTick(db, key);
        } catch (e) {
          console.error(
            "[sweeper] reconciler lane tick failed:",
            laneKeyId(key),
            errorMessage(e),
          );
        }
        // Invariant: no code path may run >30 s without a heartbeat touch.
        if (++healedCount % 10 === 0) await touchHeartbeat(db);
      }
    } catch (e) {
      console.error("[sweeper] campaign reconciler failed:", errorMessage(e));
    }
  }
}

/** Startup recovery: `pending` sim_jobs are pre-boundary compositions owned by
 * the previous sweeper process, never live engine work. Terminalize them before
 * measuring queue pressure, release their claims, and settle their ladder work
 * items immediately. A campaign precalc one-shot retry is deliberately queued
 * with no owner until the gated parent rescan composes its next wave-2 child;
 * preserve that durable routing marker or restart would demote it to RANS. */
export async function resetOrphans(
  db: DB,
  opts: { jobIds?: string[]; resultIds?: string[] } = {},
): Promise<void> {
  const pendingFilters = [eq(simJobs.status, "pending")];
  if (opts.jobIds?.length)
    pendingFilters.push(inArray(simJobs.id, opts.jobIds));
  const cancelledPending = await db.transaction(async (tx) => {
    const cancelled = await tx
      .update(simJobs)
      .set({
        status: "cancelled",
        engineState: "cancelled",
        error:
          "sweeper restarted before engine submission; composition cancelled and claims released",
        finishedAt: new Date(),
      })
      .where(and(...pendingFilters))
      .returning({ id: simJobs.id });
    if (cancelled.length) {
      await tx
        .update(results)
        .set({
          status: releasedResultStatusSql(results.simJobId),
          source: "queued",
          simJobId: null,
          engineJobId: null,
          engineCaseSlug: null,
        })
        .where(
          and(
            inArray(
              results.simJobId,
              cancelled.map((row) => row.id),
            ),
            inArray(results.status, ["queued", "running"]),
          ),
        );
    }
    return cancelled.map((row) => row.id);
  });

  if (cancelledPending.length) {
    const ids = sql`ARRAY[${sql.join(
      cancelledPending.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}]`;
    await db.execute(sql`
      UPDATE sim_urans_verify_queue q
      SET state = CASE
            WHEN q.background_owner THEN 'pending'
            WHEN EXISTS (
              SELECT 1
              FROM sim_urans_verify_queue_campaigns ownership
              JOIN sim_campaigns camp ON camp.id = ownership.campaign_id
              WHERE ownership.queue_id = q.id
                AND ownership.state = 'active'
                AND camp.status IN ('active', 'attention', 'paused')
            ) THEN 'pending'
            ELSE 'cancelled'
          END,
          "updatedAt" = now()
      WHERE q.state = 'running'
        AND EXISTS (
          SELECT 1 FROM sim_jobs j
          WHERE j.id = ANY(${ids})
            AND j.request_payload ->> 'verifyQueueItemId' = q.id::text
        )
    `);
    await db.execute(sql`
      WITH linked_request AS (
        SELECT DISTINCT ON (req.id)
          req.id AS request_id,
          j.id AS job_id,
          (
            req.background_owner
            OR EXISTS (
              SELECT 1
              FROM sim_urans_request_campaigns ownership
              JOIN sim_campaigns camp ON camp.id = ownership.campaign_id
              WHERE ownership.request_id = req.id
                AND ownership.state = 'active'
                AND camp.status IN ('active', 'attention', 'paused')
            )
          ) AS may_resume
        FROM sim_urans_requests req
        JOIN sim_jobs j
          ON j.id = ANY(${ids})
         AND (
           req.sim_job_id = j.id
           OR j.request_payload ->> 'uransRequestId' = req.id::text
         )
        WHERE req.state = 'running'
        ORDER BY req.id, j."createdAt" DESC
      )
      UPDATE sim_urans_requests req
      SET state = CASE WHEN linked_request.may_resume THEN 'pending' ELSE 'cancelled' END,
          sim_job_id = CASE WHEN linked_request.may_resume THEN NULL ELSE linked_request.job_id END,
          "updatedAt" = now()
      FROM linked_request
      WHERE req.id = linked_request.request_id
    `);
  }

  const liveFilters = [
    inArray(simJobs.status, ["submitted", "running", "ingesting"] as const),
  ];
  if (opts.jobIds?.length) liveFilters.push(inArray(simJobs.id, opts.jobIds));
  const live = await db
    .select({ id: simJobs.id })
    .from(simJobs)
    .where(and(...liveFilters));
  const liveIds = live.map((row) => row.id);
  const claimed = inArray(results.status, ["queued", "running"]);
  const scopedClaim = opts.resultIds?.length
    ? and(claimed, inArray(results.id, opts.resultIds))
    : opts.jobIds?.length
      ? and(claimed, inArray(results.simJobId, opts.jobIds))
      : claimed;
  await db
    .update(results)
    .set({ status: "pending", source: "queued", simJobId: null })
    .where(
      and(
        liveIds.length
          ? and(
              scopedClaim,
              or(
                isNull(results.simJobId),
                notInArray(results.simJobId, liveIds),
              ),
            )
          : scopedClaim,
        sql`NOT (
          ${results.status} = 'queued'
          AND ${results.simJobId} IS NULL
          AND ${EVIDENCE_BACKED_WAVE2_RESULT_SQL}
        )`,
      ),
    );
}
