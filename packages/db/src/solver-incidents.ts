import { and, eq, inArray, sql } from "drizzle-orm";

import type { DB } from "./client";
import {
  simSolverIncidentCampaigns,
  simSolverIncidents,
  type SimSolverIncident,
} from "./schema";

/** Bump when the recovery decision itself changes. Incident summaries keep
 * versions separate so recurrence before and after a correction is visible. */
export const URANS_RECOVERY_REMEDIATION_VERSION =
  "urans-recovery-2026-07-16-v1";
export const RANS_RECOVERY_REMEDIATION_VERSION =
  "rans-recovery-2026-07-16-v1";

export function ransMeshRecoveryRemediationVersion(version: number): string {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error("RANS mesh recovery version must be a non-negative integer");
  }
  return `rans-mesh-recovery-v${version}`;
}

/** Three physical solver-recovery occurrences with the same implementation,
 * stage, reason, and remediation are an algorithm/runtime pattern rather than
 * an isolated point anomaly. */
export const REPEATED_SOLVER_INCIDENT_THRESHOLD = 3;

export type SolverIncidentStage = "rans" | "preliminary" | "final";
export type SolverIncidentSeverity = "warning" | "critical";
export type SolverIncidentOwner =
  | { resultId: string }
  | { precalcObligationId: string }
  | { verifyQueueId: string }
  | { uransRequestId: string };

export interface RecordSolverIncidentInput {
  stage: SolverIncidentStage;
  reason: string;
  severity: SolverIncidentSeverity;
  owner: SolverIncidentOwner;
  solverImplementationId: string;
  occurrenceKey: string;
  remediationVersion?: string;
  simJobId?: string | null;
  resultAttemptId?: string | null;
  campaignIds?: string[];
  metadata?: Record<string, unknown>;
}

const ownerColumns = (owner: SolverIncidentOwner) => ({
  resultId: "resultId" in owner ? owner.resultId : null,
  precalcObligationId:
    "precalcObligationId" in owner ? owner.precalcObligationId : null,
  verifyQueueId: "verifyQueueId" in owner ? owner.verifyQueueId : null,
  uransRequestId: "uransRequestId" in owner ? owner.uransRequestId : null,
});

function ownerPredicate(owner: SolverIncidentOwner) {
  if ("resultId" in owner) {
    return eq(simSolverIncidents.resultId, owner.resultId);
  }
  if ("precalcObligationId" in owner) {
    return eq(
      simSolverIncidents.precalcObligationId,
      owner.precalcObligationId,
    );
  }
  if ("verifyQueueId" in owner) {
    return eq(simSolverIncidents.verifyQueueId, owner.verifyQueueId);
  }
  return eq(simSolverIncidents.uransRequestId, owner.uransRequestId);
}

async function ownerCampaignIds(
  tx: DB,
  owner: SolverIncidentOwner,
): Promise<string[]> {
  if ("resultId" in owner) {
    const rows = (await tx.execute(sql`
      SELECT DISTINCT point.campaign_id
      FROM sim_campaign_points point
      WHERE point.result_id = ${owner.resultId}
        AND point.state <> 'released'
      ORDER BY point.campaign_id
    `)) as unknown as Array<{ campaign_id: string }>;
    return rows.map((row) => row.campaign_id);
  }
  if ("precalcObligationId" in owner) {
    const rows = (await tx.execute(sql`
      SELECT DISTINCT ownership.campaign_id
      FROM sim_precalc_obligation_campaigns ownership
      WHERE ownership.obligation_id = ${owner.precalcObligationId}
        AND ownership.state = 'active'
      ORDER BY ownership.campaign_id
    `)) as unknown as Array<{ campaign_id: string }>;
    return rows.map((row) => row.campaign_id);
  }
  if ("verifyQueueId" in owner) {
    const rows = (await tx.execute(sql`
      SELECT campaign_id
      FROM (
        SELECT ownership.campaign_id
        FROM sim_urans_verify_queue_campaigns ownership
        WHERE ownership.queue_id = ${owner.verifyQueueId}
          AND ownership.state = 'active'
        UNION
        SELECT request_ownership.campaign_id
        FROM sim_urans_verify_queue_requests coverage
        JOIN sim_urans_request_campaigns request_ownership
          ON request_ownership.request_id = coverage.request_id
        WHERE coverage.queue_id = ${owner.verifyQueueId}
          AND request_ownership.state = 'active'
      ) campaigns
      ORDER BY campaign_id
    `)) as unknown as Array<{ campaign_id: string }>;
    return rows.map((row) => row.campaign_id);
  }
  const rows = (await tx.execute(sql`
    SELECT DISTINCT ownership.campaign_id
    FROM sim_urans_request_campaigns ownership
    WHERE ownership.request_id = ${owner.uransRequestId}
      AND ownership.state = 'active'
    ORDER BY ownership.campaign_id
  `)) as unknown as Array<{ campaign_id: string }>;
  return rows.map((row) => row.campaign_id);
}

/** Record one immutable recovery occurrence. Reconciliation replay is
 * idempotent by occurrenceKey and never reopens an already resolved event. */
export async function recordSolverIncidentInTransaction(
  tx: DB,
  input: RecordSolverIncidentInput,
): Promise<SimSolverIncident> {
  const reason = input.reason.trim();
  const occurrenceKey = input.occurrenceKey.trim();
  const remediationVersion = (
    input.remediationVersion ?? URANS_RECOVERY_REMEDIATION_VERSION
  ).trim();
  if (!reason) throw new Error("solver incident reason is required");
  if (!occurrenceKey)
    throw new Error("solver incident occurrence key is required");
  if (!remediationVersion)
    throw new Error("solver incident remediation version is required");

  const [inserted] = await tx
    .insert(simSolverIncidents)
    .values({
      stage: input.stage,
      reason,
      severity: input.severity,
      ...ownerColumns(input.owner),
      solverImplementationId: input.solverImplementationId,
      occurrenceKey,
      remediationVersion,
      simJobId: input.simJobId ?? null,
      resultAttemptId: input.resultAttemptId ?? null,
      metadata: input.metadata ?? {},
    })
    .onConflictDoNothing({
      target: simSolverIncidents.occurrenceKey,
    })
    .returning();
  const incident =
    inserted ??
    (
      await tx
        .select()
        .from(simSolverIncidents)
        .where(eq(simSolverIncidents.occurrenceKey, occurrenceKey))
        .limit(1)
    )[0];
  if (!incident) {
    throw new Error(
      `solver incident ${occurrenceKey} disappeared after insert`,
    );
  }

  // Campaign attribution belongs to the instant the occurrence was first
  // observed. A reconciliation replay after another campaign starts sharing
  // the physical owner must not rewrite that new campaign's history.
  if (inserted) {
    const campaignIds = [
      ...new Set(
        input.campaignIds ?? (await ownerCampaignIds(tx, input.owner)),
      ),
    ].sort();
    if (campaignIds.length) {
      await tx
        .insert(simSolverIncidentCampaigns)
        .values(
          campaignIds.map((campaignId) => ({
            incidentId: incident.id,
            campaignId,
          })),
        )
        .onConflictDoNothing();
    }
  }
  return incident;
}

export async function recordSolverIncident(
  db: DB,
  input: RecordSolverIncidentInput,
): Promise<SimSolverIncident> {
  return db.transaction((rawTx) =>
    recordSolverIncidentInTransaction(rawTx as unknown as DB, input),
  );
}

/** Accepted evidence closes operational recovery incidents for the same
 * physical owner while preserving immutable recurrence history. */
export async function resolveSolverIncidentsForOwnerInTransaction(
  tx: DB,
  owner: SolverIncidentOwner,
): Promise<number> {
  const resolved = await tx
    .update(simSolverIncidents)
    .set({
      status: "resolved",
      resolvedAt: new Date(),
    })
    .where(and(ownerPredicate(owner), eq(simSolverIncidents.status, "open")))
    .returning({ id: simSolverIncidents.id });
  return resolved.length;
}

export async function resolveSolverIncidentsForOwner(
  db: DB,
  owner: SolverIncidentOwner,
): Promise<number> {
  return db.transaction((rawTx) =>
    resolveSolverIncidentsForOwnerInTransaction(rawTx as unknown as DB, owner),
  );
}

/** Resolve result-owned recovery incidents only after the canonical
 * result-level classifier selected accepted publishable evidence. The caller
 * supplies those accepted result ids from the same revision-locked
 * transaction; rejected/needs-URANS rows are deliberately absent. */
export async function resolveSolverIncidentsForAcceptedResultsInTransaction(
  tx: DB,
  resultIds: string[],
): Promise<number> {
  const uniqueIds = [...new Set(resultIds)];
  if (!uniqueIds.length) return 0;
  const resolved = await tx
    .update(simSolverIncidents)
    .set({
      status: "resolved",
      resolvedAt: new Date(),
    })
    .where(
      and(
        inArray(simSolverIncidents.resultId, uniqueIds),
        eq(simSolverIncidents.status, "open"),
      ),
    )
    .returning({ id: simSolverIncidents.id });
  return resolved.length;
}

/** A newer engine mesh strategy reopens only deterministic mesh incidents
 * produced by an older acknowledged strategy. Generic crash/submit incidents
 * remain open, and same-version retries cannot erase their own recurrence. */
export async function resolveOlderRansMeshIncidentsInTransaction(
  tx: DB,
  resultIds: string[],
  meshRecoveryVersion: number,
): Promise<number> {
  if (
    !Number.isSafeInteger(meshRecoveryVersion) ||
    meshRecoveryVersion <= 0
  ) {
    throw new Error("new RANS mesh recovery version must be a positive integer");
  }
  const uniqueIds = [...new Set(resultIds)];
  if (!uniqueIds.length) return 0;
  const resolved = (await tx.execute(sql`
    UPDATE sim_solver_incidents incident
    SET status = 'resolved',
        resolved_at = now(),
        "updatedAt" = now()
    WHERE incident.result_id = ANY(${sql`ARRAY[${sql.join(
      uniqueIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}]`})
      AND incident.stage = 'rans'
      AND incident.reason = 'mesh-quality-failure'
      AND incident.status = 'open'
      AND CASE
        WHEN incident.metadata ->> 'meshRecoveryVersion' ~ '^[0-9]+$'
        THEN (incident.metadata ->> 'meshRecoveryVersion')::int
        ELSE 0
      END < ${meshRecoveryVersion}
    RETURNING incident.id
  `)) as unknown as Array<{ id: string }>;
  return resolved.length;
}

export interface SolverIncidentAggregate {
  stage: SolverIncidentStage;
  reason: string;
  solverImplementationId: string;
  solverImplementationKey: string;
  remediationVersion: string;
  occurrenceCount: number;
  openCount: number;
  openCriticalCount: number;
  firstOccurredAt: string;
  lastOccurredAt: string;
  requiresInvestigation: boolean;
  effectiveSeverity: SolverIncidentSeverity;
}

export interface SolverIncidentSummary {
  threshold: number;
  occurrenceCount: number;
  openCount: number;
  criticalGroupCount: number;
  groups: SolverIncidentAggregate[];
}

/** Durable recurrence read model for campaign and health surfaces. The time
 * window limits resolved history only; unresolved incidents are always shown. */
export async function solverIncidentSummary(
  db: DB,
  opts: {
    campaignId?: string;
    since?: Date;
    limit?: number;
  } = {},
): Promise<SolverIncidentSummary> {
  const campaignSql = opts.campaignId
    ? sql`AND EXISTS (
        SELECT 1
        FROM sim_solver_incident_campaigns ownership
        WHERE ownership.incident_id = incident.id
          AND ownership.campaign_id = ${opts.campaignId}
      )`
    : sql``;
  const sinceSql = opts.since
    ? sql`AND (
        incident.status = 'open'
        OR incident.occurred_at >= ${opts.since.toISOString()}::timestamptz
      )`
    : sql``;
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const rows = (await db.execute(sql`
    WITH grouped AS (
      SELECT
        incident.stage,
        incident.reason,
        incident.solver_implementation_id,
        implementation.key AS solver_implementation_key,
        incident.remediation_version,
        count(*)::int AS occurrence_count,
        count(*) FILTER (WHERE incident.status = 'open')::int AS open_count,
        count(*) FILTER (
          WHERE incident.status = 'open' AND incident.severity = 'critical'
        )::int AS open_critical_count,
        min(incident.occurred_at) AS first_occurred_at,
        max(incident.occurred_at) AS last_occurred_at
      FROM sim_solver_incidents incident
      JOIN solver_implementations implementation
        ON implementation.id = incident.solver_implementation_id
      WHERE true
        ${campaignSql}
        ${sinceSql}
      GROUP BY
        incident.stage,
        incident.reason,
        incident.solver_implementation_id,
        implementation.key,
        incident.remediation_version
    )
    SELECT
      grouped.*,
      (sum(grouped.occurrence_count) OVER ())::bigint
        AS total_occurrence_count,
      (sum(grouped.open_count) OVER ())::bigint AS total_open_count,
      (
        count(*) FILTER (
          WHERE
            grouped.open_critical_count > 0
            OR grouped.occurrence_count >= ${REPEATED_SOLVER_INCIDENT_THRESHOLD}
        ) OVER ()
      )::int AS total_critical_group_count
    FROM grouped
    ORDER BY
      (grouped.open_critical_count > 0) DESC,
      (
        grouped.occurrence_count >= ${REPEATED_SOLVER_INCIDENT_THRESHOLD}
      ) DESC,
      grouped.last_occurred_at DESC
    LIMIT ${limit}
  `)) as unknown as Array<{
    stage: SolverIncidentStage;
    reason: string;
    solver_implementation_id: string;
    solver_implementation_key: string;
    remediation_version: string;
    occurrence_count: number;
    open_count: number;
    open_critical_count: number;
    first_occurred_at: Date | string;
    last_occurred_at: Date | string;
    total_occurrence_count: number | string;
    total_open_count: number | string;
    total_critical_group_count: number;
  }>;
  const groups = rows.map((row): SolverIncidentAggregate => {
    const occurrenceCount = Number(row.occurrence_count);
    const openCriticalCount = Number(row.open_critical_count);
    const requiresInvestigation =
      openCriticalCount > 0 ||
      occurrenceCount >= REPEATED_SOLVER_INCIDENT_THRESHOLD;
    return {
      stage: row.stage,
      reason: row.reason,
      solverImplementationId: row.solver_implementation_id,
      solverImplementationKey: row.solver_implementation_key,
      remediationVersion: row.remediation_version,
      occurrenceCount,
      openCount: Number(row.open_count),
      openCriticalCount,
      firstOccurredAt: new Date(row.first_occurred_at).toISOString(),
      lastOccurredAt: new Date(row.last_occurred_at).toISOString(),
      requiresInvestigation,
      effectiveSeverity: requiresInvestigation ? "critical" : "warning",
    };
  });
  const totals = rows[0];
  return {
    threshold: REPEATED_SOLVER_INCIDENT_THRESHOLD,
    occurrenceCount: Number(totals?.total_occurrence_count ?? 0),
    openCount: Number(totals?.total_open_count ?? 0),
    criticalGroupCount: Number(totals?.total_critical_group_count ?? 0),
    groups,
  };
}

/** Stable reason key for classification/error combinations. */
export function solverIncidentReason(
  reasons: string[] | null | undefined,
  fallback: string,
): string {
  const normalized = [
    ...new Set((reasons ?? []).map((reason) => reason.trim())),
  ]
    .filter(Boolean)
    .sort();
  return normalized.length ? normalized.join("+") : fallback;
}
