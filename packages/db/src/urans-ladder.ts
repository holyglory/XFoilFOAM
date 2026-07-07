// URANS fidelity ladder — shared node-side helpers (pinned contracts 4–7,
// migration 0034). The sweeper consumes these in its ladder tick; the API
// reads the tier counts for the campaign summary payload.
//
// Ladder (contract 5, ONE priority scale — no second scale):
//   1. RANS work (continuous + campaign gaps)         — existing submit branch
//   2. precalc-rank work                              — gated wave-2 URANS
//      (per campaign: only once that campaign has ZERO open RANS gaps) and
//      admin request-URANS items (contract 6)
//   3. verify-queue items (contract 4)                — ONLY when no campaign
//      RANS/precalc work exists machine-wide

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { DB } from "./client";
import { results, simUransRequests, simUransVerifyQueue, type SimUransRequest, type SimUransVerifyQueueItem } from "./schema";

// ---------------------------------------------------------------------------
// Verify-queue enqueue (contract 4): a results row that classifies ACCEPTED at
// fidelity 'urans_precalc' owes a full-fidelity verification. Idempotent via
// the partial unique index (one open item per cell).
// ---------------------------------------------------------------------------
export async function enqueuePrecalcVerifications(
  db: DB,
  opts: { airfoilId: string; revisionId: string; campaignId?: string | null },
): Promise<number> {
  const rows = (await db.execute(sql`
    INSERT INTO sim_urans_verify_queue (airfoil_id, revision_id, aoa_deg, campaign_id, state, precalc_result_id)
    SELECT r.airfoil_id, r.simulation_preset_revision_id, r.aoa_deg, ${opts.campaignId ?? null}::uuid, 'pending', r.id
    FROM results r
    JOIN result_classifications rc ON rc.result_id = r.id
    WHERE r.airfoil_id = ${opts.airfoilId}
      AND r.simulation_preset_revision_id = ${opts.revisionId}
      AND r.status = 'done'
      AND r.regime = 'urans'
      AND r.fidelity = 'urans_precalc'
      AND rc.state = 'accepted'
    ON CONFLICT (airfoil_id, revision_id, aoa_deg) WHERE state IN ('pending', 'running') DO NOTHING
    RETURNING id
  `)) as unknown as { id: string }[];
  return rows.length;
}

// ---------------------------------------------------------------------------
// Ladder gates (contract 5).
// ---------------------------------------------------------------------------

/** Per-campaign precalc gate: URANS (precalc) work is gated while the campaign
 *  still has ANY open RANS gap. "Open RANS gap" mirrors the gap finder
 *  (findCampaignGapBatch): a requested, non-derived cell on a live condition
 *  that is still SCHEDULABLE as wave-1 work (no results row, or pending/
 *  stale), plus cells whose claim is held by an IN-FLIGHT wave-1 job (RANS
 *  still solving). A requested cell claimed by a wave-2 job — or left queued
 *  by a finished parent for its wave-2 child — is URANS work, not a RANS gap,
 *  so it must never gate the very retry that resolves it. */
export async function campaignHasOpenRansGaps(db: DB, campaignId: string): Promise<boolean> {
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
        r.id IS NULL
        OR r.status IN ('pending', 'stale')
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

/** Machine-wide verify gate: verify-queue items schedule ONLY when no campaign
 *  RANS/precalc work exists anywhere — no open campaign gap, no pending
 *  admin request-URANS item, and no in-flight non-verify campaign job. */
export async function hasOpenCampaignLadderWork(db: DB): Promise<boolean> {
  const [row] = (await db.execute(sql`
    SELECT
      EXISTS (
        SELECT 1 FROM sim_campaign_points p
        JOIN sim_campaigns camp ON camp.id = p.campaign_id AND camp.status = 'active'
        JOIN sim_campaign_conditions c ON c.id = p.condition_id AND c.status IN ('active', 'kept')
        WHERE p.state = 'requested'
      ) AS rans_open,
      EXISTS (SELECT 1 FROM sim_urans_requests WHERE state = 'pending') AS requests_open,
      EXISTS (
        -- In-flight non-verify jobs of LIVE campaigns only: stale claims left
        -- behind by paused/cancelled campaigns must not starve the verify
        -- tier forever (their work is frozen, not pending).
        SELECT 1 FROM sim_jobs j
        JOIN sim_campaigns camp ON camp.id = j.campaign_id AND camp.status IN ('active', 'attention')
        WHERE j.status IN ('pending', 'submitted', 'running', 'ingesting')
          AND j.job_kind <> 'verify'
      ) AS campaign_jobs_open
  `)) as unknown as { rans_open: boolean; requests_open: boolean; campaign_jobs_open: boolean }[];
  return Boolean(row?.rans_open || row?.requests_open || row?.campaign_jobs_open);
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

export async function campaignOpenTierCounts(db: DB, campaignId: string): Promise<CampaignTierCounts> {
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
            r.id IS NULL
            OR r.status IN ('pending', 'stale')
            OR (r.status IN ('queued', 'running') AND j.wave = 1 AND j.status IN ('pending', 'submitted', 'running', 'ingesting'))
          )
      )::int AS rans_open,
      (
        -- Precalc tier: solved cells whose verdict demands URANS
        -- (needs_urans, not yet superseded) plus cells whose live row is
        -- claimed by a wave-2 re-solve (queued/running under a wave-2 job or
        -- awaiting one after the parent finished).
        SELECT count(*) FROM sim_campaign_points p
        JOIN sim_campaign_conditions c ON c.id = p.condition_id AND c.status IN ('active', 'kept')
        LEFT JOIN result_classifications rc ON rc.result_id = p.result_id
        LEFT JOIN results live
          ON live.airfoil_id = p.airfoil_id AND live.simulation_preset_revision_id = p.revision_id AND live.aoa_deg = p.aoa_deg
        LEFT JOIN sim_jobs lj ON lj.id = live.sim_job_id
        WHERE p.campaign_id = ${campaignId} AND p.derived_by_symmetry = false
          AND (
            (p.state = 'terminal' AND rc.state = 'needs_urans')
            OR (live.status IN ('queued', 'running') AND (lj.wave IS NULL OR lj.wave <> 1 OR lj.status IN ('done', 'failed', 'cancelled')))
          )
      )::int AS precalc_open,
      (
        SELECT count(*) FROM sim_urans_verify_queue q
        WHERE q.campaign_id = ${campaignId} AND q.state IN ('pending', 'running')
      )::int AS verify_open
  `)) as unknown as { rans_open: number; precalc_open: number; verify_open: number }[];
  return {
    ransOpen: Number(row?.rans_open ?? 0),
    precalcOpen: Number(row?.precalc_open ?? 0),
    verifyOpen: Number(row?.verify_open ?? 0),
  };
}

export type CampaignPhase = "running_rans" | "running_precalc" | "running_refinement" | "completed" | null;

/** Derived campaign phase (contract 7): running_rans → running_precalc →
 *  running_refinement → completed. Pure. Non-running statuses (paused,
 *  cancelled, archived) have no ladder phase; `attention`/`completed` report
 *  their own status truthfully (phase only decorates an active ladder). */
export function deriveCampaignPhase(status: string, tiers: CampaignTierCounts): CampaignPhase {
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
export async function nextPendingVerifyItem(db: DB): Promise<SimUransVerifyQueueItem | null> {
  const [item] = await db
    .select()
    .from(simUransVerifyQueue)
    .where(eq(simUransVerifyQueue.state, "pending"))
    .orderBy(asc(simUransVerifyQueue.createdAt))
    .limit(1);
  return item ?? null;
}

export async function nextPendingUransRequest(db: DB): Promise<SimUransRequest | null> {
  const [request] = await db
    .select()
    .from(simUransRequests)
    .where(eq(simUransRequests.state, "pending"))
    .orderBy(asc(simUransRequests.createdAt))
    .limit(1);
  return request ?? null;
}

/** Heal verify items stuck 'running' whose composing/solving job died without
 *  settling them (job cancelled/lost/failed before ingest): back to pending so
 *  the ladder re-consumes. A live job referencing the item keeps it running. */
export async function healOrphanedVerifyItems(db: DB): Promise<number> {
  const rows = (await db.execute(sql`
    UPDATE sim_urans_verify_queue q
    SET state = 'pending', "updatedAt" = now()
    WHERE q.state = 'running'
      AND NOT EXISTS (
        SELECT 1 FROM sim_jobs j
        WHERE j.status IN ('pending', 'submitted', 'running', 'ingesting')
          AND j.request_payload ->> 'verifyQueueItemId' = q.id::text
      )
      AND q."updatedAt" < now() - interval '5 minutes'
    RETURNING q.id
  `)) as unknown as { id: string }[];
  return rows.length;
}

/** Heal admin requests stuck 'running' after their job vanished (cancelled /
 *  lost / deleted): back to pending for a re-attempt. */
export async function healOrphanedUransRequests(db: DB): Promise<number> {
  const rows = (await db.execute(sql`
    UPDATE sim_urans_requests req
    SET state = 'pending', sim_job_id = NULL, "updatedAt" = now()
    WHERE req.state = 'running'
      AND NOT EXISTS (
        SELECT 1 FROM sim_jobs j
        WHERE j.id = req.sim_job_id
          AND j.status IN ('pending', 'submitted', 'running', 'ingesting', 'done', 'failed')
      )
      AND req."updatedAt" < now() - interval '5 minutes'
    RETURNING req.id
  `)) as unknown as { id: string }[];
  return rows.length;
}

/** Idempotent admin request-URANS creation (contract 6): one open item per
 *  (cell, fidelity); NULL aoaDeg = whole polar. Returns the open/created row
 *  and whether this call created it. */
export async function createUransRequest(
  db: DB,
  input: { airfoilId: string; revisionId: string; aoaDeg?: number | null; fidelity: "precalc" | "full"; requestedBy?: string | null },
): Promise<{ request: SimUransRequest; created: boolean }> {
  const inserted = (await db.execute(sql`
    INSERT INTO sim_urans_requests (airfoil_id, revision_id, aoa_deg, fidelity, state, requested_by)
    VALUES (${input.airfoilId}, ${input.revisionId}, ${input.aoaDeg ?? null}, ${input.fidelity}, 'pending', ${input.requestedBy ?? null})
    ON CONFLICT (airfoil_id, revision_id, COALESCE(aoa_deg, 'NaN'::float8), fidelity)
      WHERE state IN ('pending', 'running') DO NOTHING
    RETURNING *
  `)) as unknown as Record<string, unknown>[];
  if (inserted.length) {
    const [request] = await db.select().from(simUransRequests).where(eq(simUransRequests.id, String(inserted[0].id)));
    return { request, created: true };
  }
  const conditions = [
    eq(simUransRequests.airfoilId, input.airfoilId),
    eq(simUransRequests.revisionId, input.revisionId),
    eq(simUransRequests.fidelity, input.fidelity),
    inArray(simUransRequests.state, ["pending", "running"]),
    input.aoaDeg == null ? sql`${simUransRequests.aoaDeg} IS NULL` : eq(simUransRequests.aoaDeg, input.aoaDeg),
  ];
  const [existing] = await db
    .select()
    .from(simUransRequests)
    .where(and(...conditions))
    .limit(1);
  if (!existing) {
    // Raced with a settle between insert-conflict and select — retry once.
    return createUransRequest(db, input);
  }
  return { request: existing, created: false };
}

/** The precalc coefficients a verify job compares against are captured at
 *  CONSUME time (the results row still holds the precalc solve — the verify
 *  ingest will overwrite the same natural-key row). */
export interface VerifyPrecalcSnapshot {
  cl: number | null;
  cd: number | null;
  cm: number | null;
}

export async function precalcSnapshotForVerifyItem(db: DB, item: SimUransVerifyQueueItem): Promise<VerifyPrecalcSnapshot | null> {
  const [row] = await db
    .select({ cl: results.cl, cd: results.cd, cm: results.cm, status: results.status, fidelity: results.fidelity })
    .from(results)
    .where(eq(results.id, item.precalcResultId))
    .limit(1);
  if (!row || row.status !== "done" || row.fidelity !== "urans_precalc") return null;
  return { cl: row.cl, cd: row.cd, cm: row.cm };
}
