// Sweeper-side campaign execution helpers (docs/simulation-campaigns-spec.md
// §7 scheduling & execution, §8 refinement lanes). Everything the sweeper
// needs lives here — campaign candidate selection, the unified ordering
// contract with the continuous branch, ingest-time point terminal-linking and
// counter maintenance, the refinement lane state machine, and the
// low-frequency campaign reconciler. This module is independent of the
// API-side launch/plan-edit code (campaigns.ts).

import { canonicalAoa, canonicalSi, canonicalSiString } from "@aerodb/core";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";

import type { DB } from "./client";
import {
  airfoils,
  polarFitSets,
  simCampaignConditions,
  simCampaignLaneSteps,
  simCampaignLanes,
  simCampaignPlanRevisions,
  simCampaignPoints,
  simCampaigns,
} from "./schema";

// ---------------------------------------------------------------------------
// Unified ordering contract (spec §7 "one total order"): both branches are
// ranked by effectivePriority DESC, reynolds ASC, slug ASC, aoa ASC. The
// continuous branch head carries effectivePriority = the group's max
// results.priority (0 default, 10 public); the campaign branch head carries
// effectivePriority = campaign.priority (capped at 9 so public always wins).
// ---------------------------------------------------------------------------
export interface ScheduleCandidate {
  effectivePriority: number;
  reynolds: number;
  slug: string;
  aoa: number;
}

/** Negative → a schedules before b. Pure so the winner-per-tick rule is unit-testable. */
export function compareScheduleCandidates(a: ScheduleCandidate, b: ScheduleCandidate): number {
  if (a.effectivePriority !== b.effectivePriority) return b.effectivePriority - a.effectivePriority;
  if (a.reynolds !== b.reynolds) return a.reynolds - b.reynolds;
  if (a.slug !== b.slug) return a.slug < b.slug ? -1 : 1;
  return a.aoa - b.aoa;
}

// ---------------------------------------------------------------------------
// Campaign gap candidates (spec §7): sim_campaign_points state='requested' of
// ACTIVE campaigns, minus active sync-promise points, minus points whose
// results row is already queued/running/done/failed (failed rows are evidence;
// admins requeue them explicitly), excluding derivedBySymmetry rows and — for
// symmetric airfoils — any α < 0 defensively (spec §9.2/§9.4).
//
// Batching (execution-efficiency decision, 2026-07-04): one campaign job =
// (campaign, airfoil, chord, compatible physics group, identical open-angle
// set) × ALL its open speeds, so the engine meshes once per airfoil-chord and
// marches every speed×angle warm-started. Conditions may share a job ONLY if
// their pinned revision snapshots have identical ambient fluid state
// (temperature/pressure/density/dynamicViscosity — speed excluded) AND
// identical boundary/mesh/solver/output blocks (value-compared, row identity
// excluded), a single chord per job, and identical open-angle sets (ONE aoa
// list per engine request; unioning would re-solve already-solved points).
// ---------------------------------------------------------------------------

/** Case budget per batched campaign job: speeds × angles ≤ this, min 1 speed. */
export const CAMPAIGN_MAX_CASES_PER_JOB = 256;

/** Minimal structural view of the pinned revision snapshot the grouping rules
 *  read (the jsonb payload always carries these blocks). */
export interface CampaignBatchSnapshot {
  preset?: { legacyBoundaryConditionId?: string | null };
  flowState: {
    mediumId: string;
    temperatureK: number;
    pressurePa: number;
    speedMps: number;
    density: number;
    dynamicViscosity: number;
    mach?: number | null;
  };
  referenceGeometry: {
    geometryType: string;
    referenceLengthKind: string;
    referenceLengthM: number;
    spanM: number | null;
    referenceAreaM2: number | null;
  };
  boundary: {
    turbulenceIntensity: number;
    viscosityRatio: number;
    sandGrainHeight: number;
    roughnessConstant: number;
  };
  mesh: Record<string, unknown>;
  solver: Record<string, unknown>;
  output: Record<string, unknown>;
}

/** One (condition, speed) member of a batched campaign job. bcId is resolved
 *  by the sweeper claim path (snapshot legacy id first, live preset fallback). */
export interface CampaignBatchEntry {
  conditionId: string;
  revisionId: string;
  presetId: string;
  /** Canonical SI speed (canonicalSi('speedMps', …)) — the engine request and
   *  the ingest speed→condition mapping both use this exact value. */
  speed: number;
  reynolds: number;
}

/** Open (condition, angle-set) aggregate used by the pure grouping rules. */
export interface CampaignConditionCandidate {
  conditionId: string;
  revisionId: string;
  presetId: string;
  reynolds: number;
  /** Open aoas of this (campaign, condition, airfoil), ascending canonical. */
  aoas: number[];
  snapshot: CampaignBatchSnapshot;
}

export interface CampaignGapBatch {
  campaignId: string;
  airfoilId: string;
  /** Single chord per job (canonical m) — a mesh is per-chord anyway. */
  chord: number;
  /** Shared open-angle set of every entry, ascending canonical. */
  angles: number[];
  /** Batched (condition, speed) members, reynolds ASC; [0] is the min-Re
   *  anchor whose pinned snapshot supplies the job physics. */
  entries: CampaignBatchEntry[];
  effectivePriority: number;
  /** Ordering key of the one-total-order comparator: min reynolds over entries. */
  reynolds: number;
  slug: string;
  /** Ordering key of the head candidate (first row of the total order). */
  headAoa: number;
  /** Distinct open (campaign, airfoil, revision) groups among fetched candidates. */
  openGroupCount: number;
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

function withoutRowIdentity(block: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, slug: _slug, name: _name, ...values } = block ?? {};
  return values;
}

/**
 * Physics-group signature (binding batching rules 1–2): conditions may share a
 * job ONLY when this key matches — identical ambient fluid state (T, P,
 * density, dynamicViscosity; speed deliberately excluded), single chord, and
 * identical boundary/mesh/solver/output blocks compared by VALUES (row
 * id/slug/name excluded, mirroring physicsHashForSnapshot's discipline so
 * value-identical profiles group together across presets).
 */
export function campaignBatchGroupKey(snapshot: CampaignBatchSnapshot): string {
  const subset = {
    ambient: {
      mediumId: snapshot.flowState.mediumId,
      temperatureK: snapshot.flowState.temperatureK,
      pressurePa: snapshot.flowState.pressurePa,
      density: snapshot.flowState.density,
      dynamicViscosity: snapshot.flowState.dynamicViscosity,
    },
    referenceGeometry: {
      geometryType: snapshot.referenceGeometry.geometryType,
      referenceLengthKind: snapshot.referenceGeometry.referenceLengthKind,
      chord: canonicalSiString("chordM", snapshot.referenceGeometry.referenceLengthM),
      spanM: snapshot.referenceGeometry.spanM,
      referenceAreaM2: snapshot.referenceGeometry.referenceAreaM2,
    },
    boundary: {
      turbulenceIntensity: snapshot.boundary.turbulenceIntensity,
      viscosityRatio: snapshot.boundary.viscosityRatio,
      sandGrainHeight: snapshot.boundary.sandGrainHeight,
      roughnessConstant: snapshot.boundary.roughnessConstant,
    },
    mesh: withoutRowIdentity(snapshot.mesh),
    solver: withoutRowIdentity(snapshot.solver),
    output: withoutRowIdentity(snapshot.output),
  };
  return createHash("sha256").update(stableStringify(subset)).digest("hex");
}

function angleSetKey(aoas: number[]): string {
  return aoas.map((a) => canonicalAoa(a)).join(",");
}

/**
 * Pure grouping (binding rules 1–3): the head condition anchors the group;
 * every candidate with the same physics-group key AND the same open-angle set
 * joins as one (condition, speed) entry, sorted reynolds ASC (conditionId as a
 * deterministic tiebreak). Different ambients, different chords, different
 * numerics blocks, or different open-angle sets NEVER share a job.
 */
export function groupCampaignBatchEntries(
  head: CampaignConditionCandidate,
  candidates: CampaignConditionCandidate[],
): { chord: number; angles: number[]; entries: CampaignBatchEntry[] } {
  const headGroup = campaignBatchGroupKey(head.snapshot);
  const headAngles = angleSetKey(head.aoas);
  const entries = candidates
    .filter((c) => campaignBatchGroupKey(c.snapshot) === headGroup && angleSetKey(c.aoas) === headAngles)
    .map((c) => ({
      conditionId: c.conditionId,
      revisionId: c.revisionId,
      presetId: c.presetId,
      speed: canonicalSi("speedMps", c.snapshot.flowState.speedMps),
      reynolds: Number(c.reynolds),
    }))
    .sort((x, y) => (x.reynolds !== y.reynolds ? x.reynolds - y.reynolds : x.conditionId < y.conditionId ? -1 : 1));
  return {
    chord: canonicalSi("chordM", head.snapshot.referenceGeometry.referenceLengthM),
    angles: [...new Set(head.aoas.map((a) => canonicalAoa(a)))].sort((x, y) => x - y),
    entries,
  };
}

/** Case-budget chunking (binding rule 4): greedily take the lowest-Re speeds
 *  so speeds × angles ≤ maxCases, min 1 speed per job. Entries must already be
 *  reynolds ASC, so the min-Re anchor is always in the head chunk. */
export function chunkCampaignSpeeds(
  entries: CampaignBatchEntry[],
  angleCount: number,
  maxCases: number = CAMPAIGN_MAX_CASES_PER_JOB,
): CampaignBatchEntry[] {
  const maxSpeeds = Math.max(1, Math.floor(maxCases / Math.max(1, angleCount)));
  return entries.slice(0, maxSpeeds);
}

interface CampaignGapRow {
  campaign_id: string;
  condition_id: string;
  airfoil_id: string;
  aoa_deg: number;
  revision_id: string;
  preset_id: string;
  priority: number;
  reynolds: number;
  slug: string;
}

interface CampaignConditionAggregateRow {
  condition_id: string;
  revision_id: string;
  preset_id: string;
  reynolds: number;
  snapshot: CampaignBatchSnapshot;
  aoas: number[];
}

export async function findCampaignGapBatch(
  db: DB,
  opts: { limit?: number; campaignIds?: string[] } = {},
): Promise<CampaignGapBatch | null> {
  const limit = opts.limit ?? 500;
  const campaignFilter = opts.campaignIds?.length
    ? sql`AND p.campaign_id = ANY(${sql`ARRAY[${sql.join(opts.campaignIds.map((id) => sql`${id}::uuid`), sql`, `)}]`})`
    : sql``;
  const exclusions = sql`
      p.state = 'requested'
      AND p.derived_by_symmetry = false
      AND NOT (a.is_symmetric AND p.aoa_deg < 0)
      AND a."archivedAt" IS NULL
      AND a."deletedAt" IS NULL
      AND (r.id IS NULL OR r.status IN ('pending', 'stale'))
      AND NOT EXISTS (
        SELECT 1
        FROM sync_sweep_promise_points pp
        JOIN sync_sweep_promises pr ON pr.id = pp.promise_id
        WHERE pp.airfoil_id = p.airfoil_id
          AND pp.simulation_preset_revision_id = p.revision_id
          AND pp.aoa_deg = p.aoa_deg
          AND pp.status = 'active'
          AND pr.status = 'active'
          AND pr."expiresAt" > now()
      )`;
  const rows = (await db.execute(sql`
    SELECT p.campaign_id, p.condition_id, p.airfoil_id, p.aoa_deg::float8 AS aoa_deg,
           p.revision_id, cond.preset_id, camp.priority, cond.reynolds, a.slug
    FROM sim_campaign_points p
    JOIN sim_campaigns camp ON camp.id = p.campaign_id AND camp.status = 'active'
    JOIN sim_campaign_conditions cond ON cond.id = p.condition_id AND cond.status IN ('active', 'kept')
    JOIN airfoils a ON a.id = p.airfoil_id
    LEFT JOIN results r
      ON r.airfoil_id = p.airfoil_id AND r.simulation_preset_revision_id = p.revision_id AND r.aoa_deg = p.aoa_deg
    WHERE ${exclusions}
      ${campaignFilter}
    ORDER BY camp.priority DESC, cond.reynolds ASC, a.slug ASC, p.aoa_deg ASC
    LIMIT ${limit}
  `)) as unknown as CampaignGapRow[];
  if (!rows.length) return null;
  const head = rows[0];
  const groupOf = (r: CampaignGapRow) => `${r.campaign_id}:${r.airfoil_id}:${r.revision_id}`;

  // Aggregate ALL open points of the head (campaign, airfoil) per condition —
  // never the LIMITed candidate page, so open-angle-set equality is judged on
  // complete sets (a truncated page must not make two conditions look equal).
  const aggregates = (await db.execute(sql`
    SELECT p.condition_id, p.revision_id, cond.preset_id, cond.reynolds,
           rev.snapshot AS snapshot,
           array_agg(p.aoa_deg::float8 ORDER BY p.aoa_deg) AS aoas
    FROM sim_campaign_points p
    JOIN sim_campaign_conditions cond ON cond.id = p.condition_id AND cond.status IN ('active', 'kept')
    JOIN simulation_preset_revisions rev ON rev.id = p.revision_id
    JOIN airfoils a ON a.id = p.airfoil_id
    LEFT JOIN results r
      ON r.airfoil_id = p.airfoil_id AND r.simulation_preset_revision_id = p.revision_id AND r.aoa_deg = p.aoa_deg
    WHERE p.campaign_id = ${head.campaign_id}
      AND p.airfoil_id = ${head.airfoil_id}
      AND ${exclusions}
    GROUP BY p.condition_id, p.revision_id, cond.preset_id, cond.reynolds, rev.snapshot
  `)) as unknown as CampaignConditionAggregateRow[];
  const candidates: CampaignConditionCandidate[] = aggregates.map((r) => ({
    conditionId: r.condition_id,
    revisionId: r.revision_id,
    presetId: r.preset_id,
    reynolds: Number(r.reynolds),
    aoas: (r.aoas ?? []).map(Number),
    snapshot: r.snapshot,
  }));
  const headCandidate = candidates.find((c) => c.conditionId === head.condition_id);
  if (!headCandidate) return null;

  const grouped = groupCampaignBatchEntries(headCandidate, candidates);
  const entries = chunkCampaignSpeeds(grouped.entries, grouped.angles.length);
  if (!entries.length || !grouped.angles.length) return null;
  return {
    campaignId: head.campaign_id,
    airfoilId: head.airfoil_id,
    chord: grouped.chord,
    angles: grouped.angles,
    entries,
    effectivePriority: Number(head.priority),
    reynolds: entries[0].reynolds,
    slug: head.slug,
    headAoa: Number(head.aoa_deg),
    openGroupCount: new Set(rows.map(groupOf)).size,
  };
}

// ---------------------------------------------------------------------------
// Ingest hooks (spec §7): terminal-link campaign points, flip derived-by-
// symmetry cells alongside their +α source, bump progress counters
// idempotently (recompute from points+results, never blind increments),
// enqueue dirty lane keys, and run the cheap completion probe.
// ---------------------------------------------------------------------------
export interface CampaignLaneKey {
  campaignId: string;
  airfoilId: string;
  conditionId: string;
  objective: string;
}

export function laneKeyId(key: CampaignLaneKey): string {
  return `${key.campaignId}:${key.airfoilId}:${key.conditionId}:${key.objective}`;
}

export interface ResultIngestSignal {
  airfoilId: string;
  revisionId: string | null;
  aoaDeg: number;
  resultId: string;
  status: string;
  regime?: string | null;
}

interface ProgressKeyRow {
  campaign_id: string;
  condition_id: string;
  airfoil_id: string;
}

function dedupeProgressKeys(rows: ProgressKeyRow[]): ProgressKeyRow[] {
  const seen = new Map<string, ProgressKeyRow>();
  for (const row of rows) seen.set(`${row.campaign_id}:${row.condition_id}:${row.airfoil_id}`, row);
  return [...seen.values()];
}

/** Idempotent counter maintenance: recompute the affected (campaign, condition,
 *  airfoil) rows from sim_campaign_points + results instead of incrementing.
 *  CANONICAL counter model (shared verbatim with recomputeProgressForCampaign
 *  and the launch/plan-edit recomputeCampaignProgress wrapper in campaigns.ts):
 *   - requested:  state <> 'released' — TOTAL obligation (the UI denominator
 *                 and deriveCampaignCompletion both read it as the whole
 *                 obligated cell count, not just still-open cells)
 *   - solved:     terminal, non-derived, result.status='done' AND the point's
 *                 classification is NOT 'rejected' (accepted / needs_urans /
 *                 superseded_by_urans / not-yet-classified all count; a
 *                 physics-REJECTED point must never book as solved work)
 *   - rejected:   terminal, non-derived, result.status='done' AND
 *                 result_classifications.state='rejected'
 *   - failed:     terminal, result.status='failed'
 *   - running:    requested AND live-cell result.status IN (queued, running)
 *   - superseded: result_classifications.state='superseded_by_urans'
 *   - derived:    terminal AND derived_by_symmetry
 *  Do not diverge these between the incremental and whole-campaign paths — the
 *  first production campaign drifted precisely because two paths disagreed. */
/** Tuple lists are bounded per statement: beyond this, template flattening
 *  overflows the JS stack and postgres's 65,534-parameter cap looms. Callers
 *  with whole-campaign scope use recomputeProgressForCampaign instead. */
const PROGRESS_KEY_CHUNK = 500;

async function recomputeProgressForKeys(db: DB, keys: ProgressKeyRow[]): Promise<void> {
  if (!keys.length) return;
  if (keys.length > PROGRESS_KEY_CHUNK) {
    for (let i = 0; i < keys.length; i += PROGRESS_KEY_CHUNK) {
      await recomputeProgressForKeys(db, keys.slice(i, i + PROGRESS_KEY_CHUNK));
    }
    return;
  }
  const tuples = sql.join(
    keys.map((k) => sql`(${k.campaign_id}::uuid, ${k.condition_id}::uuid, ${k.airfoil_id}::uuid)`),
    sql`, `,
  );
  await db.execute(sql`
    INSERT INTO sim_campaign_progress (campaign_id, condition_id, airfoil_id, requested, solved, failed, running, superseded, derived, rejected)
    SELECT p.campaign_id, p.condition_id, p.airfoil_id,
           COUNT(*) FILTER (WHERE p.state <> 'released')::int,
           COUNT(*) FILTER (WHERE p.state = 'terminal' AND p.derived_by_symmetry = false AND r.status = 'done' AND rc.state IS DISTINCT FROM 'rejected')::int,
           COUNT(*) FILTER (WHERE p.state = 'terminal' AND r.status = 'failed')::int,
           COUNT(*) FILTER (WHERE p.state = 'requested' AND live.status IN ('queued', 'running'))::int,
           COUNT(*) FILTER (WHERE rc.state = 'superseded_by_urans')::int,
           COUNT(*) FILTER (WHERE p.state = 'terminal' AND p.derived_by_symmetry = true)::int,
           COUNT(*) FILTER (WHERE p.state = 'terminal' AND p.derived_by_symmetry = false AND r.status = 'done' AND rc.state = 'rejected')::int
    FROM sim_campaign_points p
    LEFT JOIN results r ON r.id = p.result_id
    LEFT JOIN results live
      ON live.airfoil_id = p.airfoil_id AND live.simulation_preset_revision_id = p.revision_id AND live.aoa_deg = p.aoa_deg
    LEFT JOIN result_classifications rc ON rc.result_id = p.result_id
    WHERE (p.campaign_id, p.condition_id, p.airfoil_id) IN (${tuples})
    GROUP BY p.campaign_id, p.condition_id, p.airfoil_id
    ON CONFLICT (campaign_id, condition_id, airfoil_id) DO UPDATE SET
      requested = excluded.requested,
      solved = excluded.solved,
      failed = excluded.failed,
      running = excluded.running,
      superseded = excluded.superseded,
      derived = excluded.derived,
      rejected = excluded.rejected,
      "updatedAt" = now()
  `);
}

/** Whole-campaign counter recompute, fully set-based (no key enumeration):
 *  the reconciler's heal path for campaigns whose key count can reach 10^5. */
export async function recomputeProgressForCampaign(db: DB, campaignId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO sim_campaign_progress (campaign_id, condition_id, airfoil_id, requested, solved, failed, running, superseded, derived, rejected)
    SELECT p.campaign_id, p.condition_id, p.airfoil_id,
           COUNT(*) FILTER (WHERE p.state <> 'released')::int,
           COUNT(*) FILTER (WHERE p.state = 'terminal' AND p.derived_by_symmetry = false AND r.status = 'done' AND rc.state IS DISTINCT FROM 'rejected')::int,
           COUNT(*) FILTER (WHERE p.state = 'terminal' AND r.status = 'failed')::int,
           COUNT(*) FILTER (WHERE p.state = 'requested' AND live.status IN ('queued', 'running'))::int,
           COUNT(*) FILTER (WHERE rc.state = 'superseded_by_urans')::int,
           COUNT(*) FILTER (WHERE p.state = 'terminal' AND p.derived_by_symmetry = true)::int,
           COUNT(*) FILTER (WHERE p.state = 'terminal' AND p.derived_by_symmetry = false AND r.status = 'done' AND rc.state = 'rejected')::int
    FROM sim_campaign_points p
    LEFT JOIN results r ON r.id = p.result_id
    LEFT JOIN results live
      ON live.airfoil_id = p.airfoil_id AND live.simulation_preset_revision_id = p.revision_id AND live.aoa_deg = p.aoa_deg
    LEFT JOIN result_classifications rc ON rc.result_id = p.result_id
    WHERE p.campaign_id = ${campaignId}
    GROUP BY p.campaign_id, p.condition_id, p.airfoil_id
    ON CONFLICT (campaign_id, condition_id, airfoil_id) DO UPDATE SET
      requested = excluded.requested,
      solved = excluded.solved,
      failed = excluded.failed,
      running = excluded.running,
      superseded = excluded.superseded,
      derived = excluded.derived,
      rejected = excluded.rejected,
      "updatedAt" = now()
  `);
}

/** Cheap completion probe (partial-index EXISTS; spec §6.4): flips an active
 *  campaign to completed (zero failed/rejected) or attention (all terminal,
 *  failed>0 OR rejected>0) once no obligated cell is open, no lane is still
 *  seeding/iterating, and no terminal point's live cell is being re-solved.
 *
 *  The in-flight guard closes the premature-completion window: during a
 *  wave-2 URANS re-solve the campaign point stays 'terminal' while its
 *  cell-key results row is queued/running — neither "open" nor "running" by
 *  the older probes, so any probe could flip the campaign to completed
 *  mid-solve. Such a point now blocks the transition. 'pending' and 'stale'
 *  block too: a lost wave-2 job resets its cell row to 'pending' (reconcile
 *  requeueLostJob) — still re-solve intent, and the sweeper re-claims pending
 *  rows, so this cannot deadlock the probe. */
export async function probeCampaignCompletion(db: DB, campaignId: string): Promise<void> {
  const [probe] = (await db.execute(sql`
    SELECT
      EXISTS (
        SELECT 1 FROM sim_campaign_points p
        JOIN sim_campaign_conditions c ON c.id = p.condition_id
        WHERE p.campaign_id = ${campaignId} AND p.state = 'requested' AND c.status IN ('active', 'kept')
      ) AS open,
      EXISTS (
        SELECT 1 FROM sim_campaign_lanes l
        WHERE l.campaign_id = ${campaignId} AND l.state IN ('awaiting_seed', 'iterating')
      ) AS lanes_open,
      EXISTS (
        SELECT 1 FROM sim_campaign_points p
        JOIN sim_campaign_conditions c ON c.id = p.condition_id
        JOIN results live
          ON live.airfoil_id = p.airfoil_id AND live.simulation_preset_revision_id = p.revision_id AND live.aoa_deg = p.aoa_deg
        WHERE p.campaign_id = ${campaignId} AND p.state = 'terminal' AND c.status IN ('active', 'kept')
          AND live.status IN ('queued', 'running', 'pending', 'stale')
      ) AS in_flight,
      EXISTS (
        -- Done-but-not-yet-classified: the ingest-time probe fires BEFORE the
        -- polar cache refresh classifies the fresh rows, so a campaign whose
        -- last point just landed must wait for its verdict instead of booking
        -- completed on unjudged evidence (the sweeper re-probes after refresh).
        SELECT 1 FROM sim_campaign_points p
        JOIN sim_campaign_conditions c ON c.id = p.condition_id
        JOIN results r ON r.id = p.result_id
        WHERE p.campaign_id = ${campaignId} AND p.state = 'terminal' AND c.status IN ('active', 'kept')
          AND p.derived_by_symmetry = false AND r.status = 'done'
          AND NOT EXISTS (SELECT 1 FROM result_classifications rc2 WHERE rc2.result_id = r.id)
      ) AS awaiting_verdict,
      EXISTS (
        SELECT 1 FROM sim_campaign_points p
        JOIN sim_campaign_conditions c ON c.id = p.condition_id
        JOIN results r ON r.id = p.result_id
        WHERE p.campaign_id = ${campaignId} AND p.state = 'terminal' AND c.status IN ('active', 'kept')
          AND r.status = 'failed'
      ) AS has_failed,
      EXISTS (
        SELECT 1 FROM sim_campaign_points p
        JOIN sim_campaign_conditions c ON c.id = p.condition_id
        JOIN results r ON r.id = p.result_id
        JOIN result_classifications rc ON rc.result_id = r.id
        WHERE p.campaign_id = ${campaignId} AND p.state = 'terminal' AND c.status IN ('active', 'kept')
          AND p.derived_by_symmetry = false AND r.status = 'done' AND rc.state = 'rejected'
      ) AS has_rejected
  `)) as unknown as {
    open: boolean;
    lanes_open: boolean;
    in_flight: boolean;
    awaiting_verdict: boolean;
    has_failed: boolean;
    has_rejected: boolean;
  }[];
  if (!probe || probe.open || probe.lanes_open || probe.in_flight || probe.awaiting_verdict) return;
  if (probe.has_failed || probe.has_rejected) {
    await db
      .update(simCampaigns)
      .set({ status: "attention" })
      .where(and(eq(simCampaigns.id, campaignId), eq(simCampaigns.status, "active")));
  } else {
    await db
      .update(simCampaigns)
      .set({ status: "completed", completedAt: new Date() })
      .where(and(eq(simCampaigns.id, campaignId), eq(simCampaigns.status, "active")));
  }
}

async function lanesForProgressKeys(db: DB, keys: ProgressKeyRow[]): Promise<CampaignLaneKey[]> {
  if (!keys.length) return [];
  const tuples = sql.join(
    keys.map((k) => sql`(${k.campaign_id}::uuid, ${k.airfoil_id}::uuid, ${k.condition_id}::uuid)`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    SELECT campaign_id, airfoil_id, condition_id, objective
    FROM sim_campaign_lanes
    WHERE (campaign_id, airfoil_id, condition_id) IN (${tuples})
  `)) as unknown as { campaign_id: string; airfoil_id: string; condition_id: string; objective: string }[];
  return rows.map((r) => ({
    campaignId: r.campaign_id,
    airfoilId: r.airfoil_id,
    conditionId: r.condition_id,
    objective: r.objective,
  }));
}

/**
 * Ingest hook: link the matching campaign points to the just-upserted results
 * row, flip derived-by-symmetry cells when their +α source lands (canonical
 * negation), recompute the affected progress counters, run the completion
 * probe, and return the dirty lane keys the caller should drain via laneTick
 * AFTER refreshing the polar fit cache for the revision.
 */
export async function onResultIngested(db: DB, signal: ResultIngestSignal): Promise<CampaignLaneKey[]> {
  if (!signal.revisionId) return [];
  const aoa = canonicalAoa(signal.aoaDeg);
  const terminal = signal.status === "done" || signal.status === "failed";
  const affected: ProgressKeyRow[] = [];

  if (terminal) {
    // Direct point terminal-linking. Released points are NEVER resurrected
    // (spec §6.3 no-resurrection): late evidence stays evidence and the
    // condition's "gained evidence" state is derived at read time.
    const direct = (await db.execute(sql`
      UPDATE sim_campaign_points
      SET state = 'terminal', result_id = ${signal.resultId}, "updatedAt" = now()
      WHERE airfoil_id = ${signal.airfoilId} AND revision_id = ${signal.revisionId}
        AND aoa_deg = ${aoa} AND derived_by_symmetry = false AND state = 'requested'
      RETURNING campaign_id, condition_id, airfoil_id
    `)) as unknown as ProgressKeyRow[];
    affected.push(...direct);

    // Symmetric airfoils: the −α derived cell goes terminal alongside its +α
    // source, resultId pointing at the +α results row (spec §9.2).
    if (aoa > 0) {
      const mirrored = (await db.execute(sql`
        UPDATE sim_campaign_points p
        SET state = 'terminal', result_id = ${signal.resultId}, "updatedAt" = now()
        FROM airfoils a
        WHERE a.id = p.airfoil_id AND a.is_symmetric = true
          AND p.airfoil_id = ${signal.airfoilId} AND p.revision_id = ${signal.revisionId}
          AND p.aoa_deg = ${canonicalAoa(-aoa)} AND p.derived_by_symmetry = true AND p.state = 'requested'
        RETURNING p.campaign_id, p.condition_id, p.airfoil_id
      `)) as unknown as ProgressKeyRow[];
      affected.push(...mirrored);
    }

    // Idempotent re-ingest: rows already linked to this result still need
    // their counters recomputed (status may have changed failed → done).
    const linked = (await db.execute(sql`
      SELECT campaign_id, condition_id, airfoil_id
      FROM sim_campaign_points
      WHERE result_id = ${signal.resultId}
    `)) as unknown as ProgressKeyRow[];
    affected.push(...linked);
  } else {
    // queued/running transitions only move the `running` counter.
    const runningKeys = (await db.execute(sql`
      SELECT campaign_id, condition_id, airfoil_id
      FROM sim_campaign_points
      WHERE airfoil_id = ${signal.airfoilId} AND revision_id = ${signal.revisionId}
        AND aoa_deg = ${aoa} AND state = 'requested'
    `)) as unknown as ProgressKeyRow[];
    affected.push(...runningKeys);
  }

  const keys = dedupeProgressKeys(affected);
  if (!keys.length) return [];
  await recomputeProgressForKeys(db, keys);
  if (!terminal) return [];

  const laneKeys = await lanesForProgressKeys(db, keys);
  for (const campaignId of new Set(keys.map((k) => k.campaign_id))) {
    await probeCampaignCompletion(db, campaignId);
  }
  return laneKeys;
}

// ---------------------------------------------------------------------------
// Refinement lanes (spec §8).
// ---------------------------------------------------------------------------
const CONVERGED_STATES = new Set(["converged_provisional", "converged_final", "converged_window", "converged_stale"]);

/** Oscillation window (spec §8 step 4): the last 3 predictions fit inside a
 *  2·tolerance window. Pure so it is unit-testable. */
export function isOscillationConverged(predictions: number[], toleranceDeg: number): boolean {
  if (predictions.length < 3) return false;
  const last = predictions.slice(-3);
  return Math.max(...last) - Math.min(...last) <= 2 * toleranceDeg + 1e-9;
}

export interface LaneTickResult {
  state: string;
  enqueuedAoaDeg: number | null;
}

interface PlanObjectiveConfig {
  enabled?: boolean;
  toleranceDeg?: string | number;
  maxRounds?: number;
}

const OBJECTIVE_DEFAULTS: Record<string, { toleranceDeg: number; maxRounds: number }> = {
  ld_max: { toleranceDeg: 0.1, maxRounds: 8 },
  cl_zero: { toleranceDeg: 0.05, maxRounds: 6 },
};

async function updateLaneState(
  db: DB,
  key: CampaignLaneKey,
  set: Partial<{ state: string; currentTargetAlpha: number | null; iterationCount: number; witnessFitSetId: string | null }>,
): Promise<void> {
  await db
    .update(simCampaignLanes)
    .set(set)
    .where(
      and(
        eq(simCampaignLanes.campaignId, key.campaignId),
        eq(simCampaignLanes.airfoilId, key.airfoilId),
        eq(simCampaignLanes.conditionId, key.conditionId),
        eq(simCampaignLanes.objective, key.objective),
      ),
    );
}

const LANE_TERMINAL_STATES = new Set([
  "converged_provisional",
  "converged_final",
  "converged_window",
  "converged_stale",
  "stalled",
  "insufficient_evidence",
  "failed",
  "symmetric_definition",
]);

/**
 * Lane state machine tick (spec §8, event-driven via the ingest dirty queue +
 * a 60 s safety sweep). Witness = the fit convergence was judged against; no
 * |α_new − α_prev| term — a base sweep that already brackets the target
 * converges at iteration 1. Enqueued refinement points are single-angle
 * campaign points at canonical 0.01°-rounded predictions.
 */
export async function laneTick(db: DB, key: CampaignLaneKey): Promise<LaneTickResult | null> {
  const [lane] = await db
    .select()
    .from(simCampaignLanes)
    .where(
      and(
        eq(simCampaignLanes.campaignId, key.campaignId),
        eq(simCampaignLanes.airfoilId, key.airfoilId),
        eq(simCampaignLanes.conditionId, key.conditionId),
        eq(simCampaignLanes.objective, key.objective),
      ),
    )
    .limit(1);
  if (!lane) return null;
  const frozen: LaneTickResult = { state: lane.state, enqueuedAoaDeg: null };

  const [campaign] = await db.select().from(simCampaigns).where(eq(simCampaigns.id, key.campaignId)).limit(1);
  // Pause/cancel semantics (§6.4): lanes only move while the campaign is active.
  if (!campaign || campaign.status !== "active") return frozen;

  const [condition] = await db
    .select()
    .from(simCampaignConditions)
    .where(eq(simCampaignConditions.id, key.conditionId))
    .limit(1);
  if (!condition || condition.status === "released") return frozen;

  const [planRev] = campaign.currentPlanRevisionId
    ? await db
        .select()
        .from(simCampaignPlanRevisions)
        .where(eq(simCampaignPlanRevisions.id, campaign.currentPlanRevisionId))
        .limit(1)
    : [];
  const objectives = (planRev?.plan as { objectives?: Record<string, PlanObjectiveConfig> } | undefined)?.objectives;
  const objectiveConfig = objectives?.[key.objective === "ld_max" ? "ldMax" : "clZero"];
  // Disabling an objective freezes its lanes at their last evidence-backed state.
  if (!objectiveConfig?.enabled) return frozen;
  const defaults = OBJECTIVE_DEFAULTS[key.objective] ?? OBJECTIVE_DEFAULTS.ld_max;
  const toleranceRaw = Number(objectiveConfig.toleranceDeg);
  const tolerance = Number.isFinite(toleranceRaw) && toleranceRaw > 0 ? toleranceRaw : defaults.toleranceDeg;
  const maxRounds = (objectiveConfig.maxRounds ?? defaults.maxRounds) + lane.extraRoundsGranted;

  const [airfoil] = await db
    .select({ isSymmetric: airfoils.isSymmetric })
    .from(airfoils)
    .where(eq(airfoils.id, key.airfoilId))
    .limit(1);
  const symmetric = airfoil?.isSymmetric ?? false;

  // Symmetric shortcut (§8/§9): α₀ = 0° by definition — no solve, stated as such.
  if (symmetric && key.objective === "cl_zero") {
    if (lane.state !== "symmetric_definition") {
      await updateLaneState(db, key, { state: "symmetric_definition", currentTargetAlpha: 0 });
    }
    return { state: "symmetric_definition", enqueuedAoaDeg: null };
  }

  const revisionId = condition.simulationPresetRevisionId;
  const [fit] = await db
    .select()
    .from(polarFitSets)
    .where(
      and(
        eq(polarFitSets.airfoilId, key.airfoilId),
        eq(polarFitSets.simulationPresetRevisionId, revisionId),
        eq(polarFitSets.isCurrent, true),
      ),
    )
    .orderBy(desc(polarFitSets.createdAt))
    .limit(1);
  const rawTarget = fit ? (key.objective === "ld_max" ? fit.alphaLdmaxFine : fit.alphaClZeroFine) : null;

  const openRows = (await db.execute(sql`
    SELECT 1 FROM sim_campaign_points
    WHERE campaign_id = ${key.campaignId} AND condition_id = ${key.conditionId} AND airfoil_id = ${key.airfoilId}
      AND state = 'requested' AND derived_by_symmetry = false
    LIMIT 1
  `)) as unknown as unknown[];
  const openPoints = openRows.length > 0;

  // Step 1: missing/insufficient fit.
  if (!fit || fit.status === "insufficient" || rawTarget == null || !Number.isFinite(rawTarget)) {
    // Seed-once rule: the base sweep is the seed — while any of its points are
    // still pending the lane waits; once everything is terminal and the fit is
    // still insufficient the lane parks in insufficient_evidence (the
    // lane-scoped requeue-failed affordance is the way back in — we never
    // auto-requeue a second seed).
    const nextState = openPoints ? "awaiting_seed" : "insufficient_evidence";
    if (lane.state !== nextState) await updateLaneState(db, key, { state: nextState });
    if (nextState === "insufficient_evidence") await probeCampaignCompletion(db, key.campaignId);
    return { state: nextState, enqueuedAoaDeg: null };
  }

  // Converged lane with an unchanged witness fit: nothing to do.
  const wasConverged = CONVERGED_STATES.has(lane.state);
  if (wasConverged && lane.witnessFitSetId === fit.id) return frozen;

  // Symmetric ld_max lanes search α ≥ 0 only (§8/§9).
  const alphaStar = symmetric && key.objective === "ld_max" ? Math.max(0, rawTarget) : rawTarget;
  const predicted = canonicalAoa(Math.round(alphaStar * 100) / 100);
  // Supersession reopen (§8 step 6): witness replaced within tolerance keeps
  // the lane converged_stale unless the machine re-confirms or re-runs.
  const reopenWithinTolerance =
    wasConverged && lane.currentTargetAlpha != null && Math.abs(predicted - lane.currentTargetAlpha) <= tolerance + 1e-9;

  // Append-only step evidence maintenance: link solved outcomes first.
  await db.execute(sql`
    UPDATE sim_campaign_lane_steps s
    SET outcome = 'solved', solved_result_id = r.id
    FROM results r
    WHERE s.campaign_id = ${key.campaignId} AND s.airfoil_id = ${key.airfoilId}
      AND s.condition_id = ${key.conditionId} AND s.objective = ${key.objective}
      AND s.outcome = 'predicted'
      AND r.airfoil_id = ${key.airfoilId} AND r.simulation_preset_revision_id = ${revisionId}
      AND r.aoa_deg = s.predicted_alpha AND r.status = 'done'
  `);
  const steps = await db
    .select()
    .from(simCampaignLaneSteps)
    .where(
      and(
        eq(simCampaignLaneSteps.campaignId, key.campaignId),
        eq(simCampaignLaneSteps.airfoilId, key.airfoilId),
        eq(simCampaignLaneSteps.conditionId, key.conditionId),
        eq(simCampaignLaneSteps.objective, key.objective),
      ),
    )
    .orderBy(asc(simCampaignLaneSteps.iteration));
  const last = steps.length ? steps[steps.length - 1] : null;

  // Step 2: append (iteration, predictedAlpha, fitSetId) when it advances the lane.
  const advances = !last || last.fitSetId !== fit.id || canonicalAoa(last.predictedAlpha) !== predicted;
  if (advances) {
    await db.execute(sql`
      UPDATE sim_campaign_lane_steps
      SET outcome = 'superseded'
      WHERE campaign_id = ${key.campaignId} AND airfoil_id = ${key.airfoilId}
        AND condition_id = ${key.conditionId} AND objective = ${key.objective}
        AND outcome = 'predicted' AND solved_result_id IS NULL AND predicted_alpha <> ${predicted}
    `);
    await db
      .insert(simCampaignLaneSteps)
      .values({
        campaignId: key.campaignId,
        airfoilId: key.airfoilId,
        conditionId: key.conditionId,
        objective: key.objective,
        iteration: (last?.iteration ?? 0) + 1,
        predictedAlpha: predicted,
        fitSetId: fit.id,
        outcome: "predicted",
      })
      .onConflictDoNothing();
  }
  const predictions = [...steps.map((s) => canonicalAoa(s.predictedAlpha)), ...(advances ? [predicted] : [])];

  // Step 3: CONVERGED iff (a) no in-flight/requested lane point, (b) accepted
  // evidence within tolerance of α* at the pinned revision, (c) the fit did
  // not move since the last prediction (fitSetId equals the latest step's).
  const evidenceRows = (await db.execute(sql`
    SELECT 1 FROM result_classifications rc
    WHERE rc.airfoil_id = ${key.airfoilId} AND rc.simulation_preset_revision_id = ${revisionId}
      AND rc.state = 'accepted' AND rc.result_id IS NOT NULL
      AND (
        abs(rc.aoa_deg - ${alphaStar}) <= ${tolerance + 1e-9}
        OR (${symmetric} AND abs(-rc.aoa_deg - ${alphaStar}) <= ${tolerance + 1e-9})
      )
    LIMIT 1
  `)) as unknown as unknown[];
  const evidenceWithinTolerance = evidenceRows.length > 0;
  const fitStable = advances ? true : last ? last.fitSetId === fit.id : false;

  if (!openPoints && evidenceWithinTolerance && fitStable) {
    const state = fit.status === "final" ? "converged_final" : "converged_provisional";
    await updateLaneState(db, key, { state, witnessFitSetId: fit.id, currentTargetAlpha: predicted });
    await probeCampaignCompletion(db, key.campaignId);
    return { state, enqueuedAoaDeg: null };
  }

  // Step 4: the canonical prediction duplicates an already-requested lane angle.
  const duplicateRows = (await db.execute(sql`
    SELECT p.state, r.status AS result_status
    FROM sim_campaign_points p
    LEFT JOIN results r ON r.id = p.result_id
    WHERE p.campaign_id = ${key.campaignId} AND p.condition_id = ${key.conditionId}
      AND p.airfoil_id = ${key.airfoilId} AND p.aoa_deg = ${predicted}
    LIMIT 1
  `)) as unknown as { state: string; result_status: string | null }[];
  const duplicate = duplicateRows[0];

  if (duplicate) {
    let state: string;
    if (duplicate.state === "terminal" && duplicate.result_status === "failed") {
      state = "failed";
    } else if (isOscillationConverged(predictions, tolerance)) {
      state = "converged_window";
    } else if (reopenWithinTolerance) {
      state = "converged_stale";
    } else if (lane.iterationCount >= maxRounds) {
      state = "stalled";
    } else {
      state = "iterating";
    }
    await updateLaneState(db, key, {
      state,
      currentTargetAlpha: predicted,
      ...(state === "converged_window" || state === "converged_stale" ? { witnessFitSetId: fit.id } : {}),
    });
    if (LANE_TERMINAL_STATES.has(state)) await probeCampaignCompletion(db, key.campaignId);
    return { state, enqueuedAoaDeg: null };
  }

  // Step 5: enqueue α* as a single-angle campaign point (targeted job at the
  // campaign priority band), bounded by maxRounds + extraRoundsGranted.
  if (lane.iterationCount >= maxRounds) {
    await updateLaneState(db, key, { state: "stalled", currentTargetAlpha: predicted });
    await probeCampaignCompletion(db, key.campaignId);
    return { state: "stalled", enqueuedAoaDeg: null };
  }
  await db
    .insert(simCampaignPoints)
    .values({
      campaignId: key.campaignId,
      conditionId: key.conditionId,
      airfoilId: key.airfoilId,
      aoaDeg: predicted,
      revisionId,
      planRevisionNumber: planRev?.revisionNumber ?? 1,
      state: "requested",
    })
    .onConflictDoNothing();
  await recomputeProgressForKeys(db, [
    { campaign_id: key.campaignId, condition_id: key.conditionId, airfoil_id: key.airfoilId },
  ]);
  await updateLaneState(db, key, {
    state: "iterating",
    iterationCount: lane.iterationCount + 1,
    currentTargetAlpha: predicted,
  });
  return { state: "iterating", enqueuedAoaDeg: predicted };
}

// ---------------------------------------------------------------------------
// Low-frequency reconciler (spec §7): counters healing (≤1 campaign per call,
// oldest-checked first), orphaned pending rows of cancelled/released campaign
// work, and lane-state consistency (stale lanes are returned for re-ticking).
// ---------------------------------------------------------------------------
export interface CampaignReconcileResult {
  campaignId: string | null;
  staleLanes: CampaignLaneKey[];
  orphanedPendingDeleted: number;
}

export async function reconcileCampaigns(db: DB): Promise<CampaignReconcileResult> {
  // Oldest-checked first: the campaign whose progress rows were refreshed the
  // longest ago (missing rows count as never checked).
  const [target] = (await db.execute(sql`
    SELECT c.id
    FROM sim_campaigns c
    LEFT JOIN sim_campaign_progress pr ON pr.campaign_id = c.id
    WHERE c.status IN ('active', 'paused', 'attention', 'completed')
    GROUP BY c.id
    ORDER BY COALESCE(MIN(pr."updatedAt"), 'epoch'::timestamptz) ASC, c."createdAt" ASC
    LIMIT 1
  `)) as unknown as { id: string }[];
  const campaignId = target?.id ?? null;

  if (campaignId) {
    // Full counter recompute for this campaign + drop counter rows whose
    // points disappeared entirely. Set-based and scoped by campaign_id: a
    // large campaign has 10^4-10^5 (condition, airfoil) keys, and enumerating
    // them as SQL tuples overflows both the JS stack (template flattening)
    // and postgres's 65,534-parameter cap.
    await recomputeProgressForCampaign(db, campaignId);
    await db.execute(sql`
      DELETE FROM sim_campaign_progress pr
      WHERE pr.campaign_id = ${campaignId}
        AND NOT EXISTS (
          SELECT 1 FROM sim_campaign_points p
          WHERE p.campaign_id = pr.campaign_id AND p.condition_id = pr.condition_id AND p.airfoil_id = pr.airfoil_id
        )
    `);
    await probeCampaignCompletion(db, campaignId);
  }

  // Orphaned pending results of cancelled/released campaign work: rows on
  // campaign-origin, disabled presets that no live campaign point requests and
  // no active sync promise covers. Continuous/library demand is untouched
  // (its presets are origin='library' or enabled).
  const deleted = (await db.execute(sql`
    DELETE FROM results r
    WHERE r.status = 'pending' AND r.source = 'queued' AND r.sim_job_id IS NULL
      AND r.simulation_preset_revision_id IN (
        SELECT rev.id FROM simulation_preset_revisions rev
        JOIN simulation_presets sp ON sp.id = rev.preset_id
        WHERE sp.origin = 'campaign' AND sp.enabled = false
      )
      AND NOT EXISTS (
        SELECT 1 FROM sim_campaign_points p
        JOIN sim_campaigns sc ON sc.id = p.campaign_id
        WHERE p.revision_id = r.simulation_preset_revision_id AND p.airfoil_id = r.airfoil_id
          AND p.aoa_deg = r.aoa_deg AND p.state = 'requested'
          AND sc.status IN ('active', 'paused', 'attention')
      )
      AND NOT EXISTS (
        SELECT 1 FROM sync_sweep_promise_points pp
        JOIN sync_sweep_promises pr ON pr.id = pp.promise_id
        WHERE pp.airfoil_id = r.airfoil_id AND pp.simulation_preset_revision_id = r.simulation_preset_revision_id
          AND pp.aoa_deg = r.aoa_deg AND pp.status = 'active' AND pr.status = 'active' AND pr."expiresAt" > now()
      )
    RETURNING r.id
  `)) as unknown as { id: string }[];

  // Lane-state consistency: seeding/iterating lanes of the selected campaign
  // plus converged lanes whose witness fit was replaced (supersession safety
  // net) get re-ticked by the caller.
  const staleLaneRows = campaignId
    ? ((await db.execute(sql`
        SELECT l.campaign_id, l.airfoil_id, l.condition_id, l.objective
        FROM sim_campaign_lanes l
        LEFT JOIN polar_fit_sets f ON f.id = l.witness_fit_set_id
        WHERE l.campaign_id = ${campaignId}
          AND (
            l.state IN ('awaiting_seed', 'iterating')
            OR (l.state IN ('converged_provisional', 'converged_final', 'converged_window')
                AND (f.id IS NULL OR f.is_current = false))
          )
      `)) as unknown as { campaign_id: string; airfoil_id: string; condition_id: string; objective: string }[])
    : [];

  return {
    campaignId,
    staleLanes: staleLaneRows.map((r) => ({
      campaignId: r.campaign_id,
      airfoilId: r.airfoil_id,
      conditionId: r.condition_id,
      objective: r.objective,
    })),
    orphanedPendingDeleted: deleted.length,
  };
}

/**
 * Released-condition "gained evidence" derivation (spec §6.3 no-resurrection):
 * a released condition whose requested angle set has since gained solved
 * evidence at the pinned revision for any campaign airfoil. Derived at read
 * time — 0026 adds no flag column. API phase: surface these condition ids as
 * the non-blocking "restore it to keep the dataset closed?" suggestion on the
 * campaign detail payload.
 */
export async function releasedConditionsWithGainedEvidence(db: DB, campaignId: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT cond.id
    FROM sim_campaign_conditions cond
    WHERE cond.campaign_id = ${campaignId} AND cond.status = 'released'
      AND EXISTS (
        SELECT 1
        FROM sim_campaign_points p
        JOIN results r
          ON r.airfoil_id = p.airfoil_id AND r.simulation_preset_revision_id = p.revision_id AND r.aoa_deg = p.aoa_deg
        WHERE p.condition_id = cond.id AND r.status = 'done' AND r.source = 'solved'
      )
  `)) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}
